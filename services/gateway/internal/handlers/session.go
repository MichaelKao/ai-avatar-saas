package handlers

import (
	"database/sql"
	"math"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// SessionHandler 會議 Session 相關處理器
type SessionHandler struct {
	db *sqlx.DB
}

// MeetingSession 會議 Session 結構
type MeetingSession struct {
	ID              uuid.UUID  `db:"id" json:"id"`
	UserID          uuid.UUID  `db:"user_id" json:"user_id"`
	Mode            string     `db:"mode" json:"mode"`
	StartedAt       time.Time  `db:"started_at" json:"started_at"`
	EndedAt         *time.Time `db:"ended_at" json:"ended_at"`
	DurationSeconds *int       `db:"duration_seconds" json:"duration_seconds"`
	TotalResponses  int        `db:"total_responses" json:"total_responses"`
	LLMModelUsed    *string    `db:"llm_model_used" json:"llm_model_used"`
}

// StartSessionRequest 開始會議請求
type StartSessionRequest struct {
	Mode string `json:"mode"` // meeting, presentation, interview
}

// NewSessionHandler 建立 SessionHandler 實例
func NewSessionHandler(db *sqlx.DB) *SessionHandler {
	return &SessionHandler{db: db}
}

// StartSession 開始新的會議 Session（免費方案每日限制 30 分鐘）
func (h *SessionHandler) StartSession(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var req StartSessionRequest
	// 允許空 body（前端可能不帶 body 呼叫）
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"data":  nil,
				"error": "請求格式錯誤",
			})
		}
	}

	// 預設模式為 meeting
	if req.Mode == "" {
		req.Mode = "meeting"
	}

	// 驗證模式
	validModes := map[string]bool{"meeting": true, "presentation": true, "interview": true}
	if !validModes[req.Mode] {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的會議模式，允許值: meeting, presentation, interview",
		})
	}

	// 檢查用戶方案
	var plan string
	err := h.db.Get(&plan,
		`SELECT plan FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶方案失敗",
		})
	}

	// 免費方案：每日限制 30 分鐘
	if plan == "free" {
		var todayUsage sql.NullInt64
		err := h.db.Get(&todayUsage,
			`SELECT COALESCE(SUM(duration_seconds), 0)
			 FROM meeting_sessions
			 WHERE user_id = $1 AND started_at >= CURRENT_DATE AND ended_at IS NOT NULL`,
			userID,
		)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"data":  nil,
				"error": "查詢使用量失敗",
			})
		}

		usedSeconds := todayUsage.Int64
		maxSeconds := int64(30 * 60) // 30 分鐘

		if usedSeconds >= maxSeconds {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"data": fiber.Map{
					"used_seconds":      usedSeconds,
					"max_seconds":       maxSeconds,
					"remaining_seconds": 0,
				},
				"error": "免費方案每日使用時間已達上限（30 分鐘），請升級方案",
			})
		}
	}

	// 檢查是否有進行中的 Session
	var activeCount int
	h.db.Get(&activeCount,
		`SELECT COUNT(*) FROM meeting_sessions
		 WHERE user_id = $1 AND ended_at IS NULL`,
		userID,
	)

	if activeCount > 0 {
		// 自動結束舊 Session（桌面 App 可能未正常關閉）
		h.db.Exec(
			`UPDATE meeting_sessions SET ended_at = NOW()
			 WHERE user_id = $1 AND ended_at IS NULL`,
			userID,
		)
	}

	// 取得用戶預設的 LLM 模型
	var llmModel sql.NullString
	h.db.Get(&llmModel,
		`SELECT llm_model FROM ai_personalities
		 WHERE user_id = $1 AND is_default = TRUE AND deleted_at IS NULL
		 LIMIT 1`,
		userID,
	)

	var modelUsed *string
	if llmModel.Valid {
		modelUsed = &llmModel.String
	}

	// 建立新的 Session
	var session MeetingSession
	err = h.db.QueryRowx(
		`INSERT INTO meeting_sessions (user_id, mode, llm_model_used)
		 VALUES ($1, $2, $3)
		 RETURNING *`,
		userID, req.Mode, modelUsed,
	).StructScan(&session)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立會議 Session 失敗",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"data":  session,
		"error": nil,
	})
}

// EndSession 結束會議 Session（計算持續時間）
func (h *SessionHandler) EndSession(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sessionID := c.Params("id")

	// 驗證 UUID 格式
	if _, err := uuid.Parse(sessionID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的 Session ID",
		})
	}

	// 查詢 Session
	var session MeetingSession
	err := h.db.Get(&session,
		`SELECT * FROM meeting_sessions WHERE id = $1 AND user_id = $2`,
		sessionID, userID,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "Session 不存在",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢 Session 失敗",
		})
	}

	// 檢查是否已結束
	if session.EndedAt != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Session 已結束",
		})
	}

	// 計算持續時間
	now := time.Now()
	durationSeconds := int(math.Round(now.Sub(session.StartedAt).Seconds()))

	// 更新 Session
	var updated MeetingSession
	err = h.db.QueryRowx(
		`UPDATE meeting_sessions
		 SET ended_at = $1, duration_seconds = $2
		 WHERE id = $3 AND user_id = $4
		 RETURNING *`,
		now, durationSeconds, sessionID, userID,
	).StructScan(&updated)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "結束 Session 失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  updated,
		"error": nil,
	})
}

// GetHistory 取得會議歷史記錄（含分頁）
func (h *SessionHandler) GetHistory(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 分頁參數
	page, _ := strconv.Atoi(c.Query("page", "1"))
	limit, _ := strconv.Atoi(c.Query("limit", "20"))

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}

	offset := (page - 1) * limit

	// 查詢總數
	var total int
	err := h.db.Get(&total,
		`SELECT COUNT(*) FROM meeting_sessions WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢會議歷史失敗",
		})
	}

	// 查詢分頁資料
	var sessions []MeetingSession
	err = h.db.Select(&sessions,
		`SELECT * FROM meeting_sessions
		 WHERE user_id = $1
		 ORDER BY started_at DESC
		 LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢會議歷史失敗",
		})
	}

	// 確保回傳空陣列而非 null
	if sessions == nil {
		sessions = []MeetingSession{}
	}

	totalPages := int(math.Ceil(float64(total) / float64(limit)))

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"sessions": sessions,
			"pagination": fiber.Map{
				"page":        page,
				"limit":       limit,
				"total":       total,
				"total_pages": totalPages,
			},
		},
		"error": nil,
	})
}
