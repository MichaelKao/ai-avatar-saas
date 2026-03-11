package handlers

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

// LogEntry 錯誤日誌條目
type LogEntry struct {
	ID        int       `json:"id"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	Path      string    `json:"path"`
	Method    string    `json:"method"`
	Status    int       `json:"status"`
	UserID    string    `json:"user_id,omitempty"`
	IP        string    `json:"ip"`
	CreatedAt time.Time `json:"created_at"`
}

// LogStore 記憶體日誌儲存（最多保留 500 條）
type LogStore struct {
	mu      sync.RWMutex
	entries []LogEntry
	nextID  int
	maxSize int
}

// 全域日誌儲存
var GlobalLogStore = &LogStore{
	entries: make([]LogEntry, 0, 500),
	maxSize: 500,
}

// Add 新增一筆日誌
func (s *LogStore) Add(entry LogEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextID++
	entry.ID = s.nextID
	entry.CreatedAt = time.Now()

	s.entries = append(s.entries, entry)

	// 超過上限就移除最舊的
	if len(s.entries) > s.maxSize {
		s.entries = s.entries[len(s.entries)-s.maxSize:]
	}
}

// GetAll 取得所有日誌（最新在前）
func (s *LogStore) GetAll(limit int) []LogEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	total := len(s.entries)
	if limit <= 0 || limit > total {
		limit = total
	}

	// 反轉：最新的排在前面
	result := make([]LogEntry, limit)
	for i := 0; i < limit; i++ {
		result[i] = s.entries[total-1-i]
	}
	return result
}

// GetErrors 只取得錯誤日誌
func (s *LogStore) GetErrors(limit int) []LogEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var errors []LogEntry
	for i := len(s.entries) - 1; i >= 0 && len(errors) < limit; i-- {
		if s.entries[i].Level == "error" || s.entries[i].Status >= 400 {
			errors = append(errors, s.entries[i])
		}
	}
	return errors
}

// Clear 清除所有日誌
func (s *LogStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make([]LogEntry, 0, 500)
}

// ErrorLoggerMiddleware 錯誤日誌中間件 — 記錄所有 4xx/5xx 回應
func ErrorLoggerMiddleware() fiber.Handler {
	return func(c *fiber.Ctx) error {
		// 執行後續 handler
		err := c.Next()

		status := c.Response().StatusCode()
		if status >= 400 {
			userID, _ := c.Locals("userID").(string)

			GlobalLogStore.Add(LogEntry{
				Level:   levelFromStatus(status),
				Message: string(c.Response().Body()),
				Path:    c.Path(),
				Method:  c.Method(),
				Status:  status,
				UserID:  userID,
				IP:      c.IP(),
			})
		}

		return err
	}
}

func levelFromStatus(status int) string {
	if status >= 500 {
		return "error"
	}
	return "warn"
}

// LogsHandler 日誌查詢端點
type LogsHandler struct{}

func NewLogsHandler() *LogsHandler {
	return &LogsHandler{}
}

// GetLogs 取得所有日誌
func (h *LogsHandler) GetLogs(c *fiber.Ctx) error {
	filter := c.Query("filter", "all") // all, errors
	limit := c.QueryInt("limit", 100)

	var entries []LogEntry
	if filter == "errors" {
		entries = GlobalLogStore.GetErrors(limit)
	} else {
		entries = GlobalLogStore.GetAll(limit)
	}

	if entries == nil {
		entries = []LogEntry{}
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"logs":  entries,
			"total": len(entries),
		},
		"error": nil,
	})
}

// ClearLogs 清除所有日誌
func (h *LogsHandler) ClearLogs(c *fiber.Ctx) error {
	GlobalLogStore.Clear()
	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "日誌已清除",
		},
		"error": nil,
	})
}
