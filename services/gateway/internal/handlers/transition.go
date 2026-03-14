package handlers

import (
	"context"
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"
)

// TransitionHandler 過渡語處理器
type TransitionHandler struct {
	db  *sqlx.DB
	rdb *redis.Client
}

// TransitionPhrase 過渡語結構
type TransitionPhrase struct {
	ID          uuid.UUID  `db:"id" json:"id"`
	Language    string     `db:"language" json:"language"`
	Style       string     `db:"style" json:"style"`
	Phrase      string     `db:"phrase" json:"phrase"`
	AudioURL    *string    `db:"audio_url" json:"audio_url"`
	AudioBase64 *string    `db:"audio_base64" json:"audio_base64"`
	DurationMs  *int       `db:"duration_ms" json:"duration_ms"`
	VoiceGender string     `db:"voice_gender" json:"voice_gender"`
	IsCached    bool       `db:"is_cached" json:"is_cached"`
	CreatedAt   time.Time  `db:"created_at" json:"created_at"`
	DeletedAt   *time.Time `db:"deleted_at" json:"-"`
}

// CachePhraseRequest 快取過渡語請求
type CachePhraseRequest struct {
	Language    string `json:"language"`
	Style       string `json:"style"`
	VoiceGender string `json:"voice_gender"`
}

// NewTransitionHandler 建立 TransitionHandler
func NewTransitionHandler(db *sqlx.DB, rdb *redis.Client) *TransitionHandler {
	return &TransitionHandler{db: db, rdb: rdb}
}

// List 列出過渡語（按語言和風格篩選）
func (h *TransitionHandler) List(c *fiber.Ctx) error {
	language := c.Query("language", "zh-TW")
	style := c.Query("style", "natural")

	var phrases []TransitionPhrase
	err := h.db.Select(&phrases,
		`SELECT * FROM transition_phrases WHERE language = $1 AND style = $2 AND deleted_at IS NULL ORDER BY created_at`,
		language, style,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢過渡語失敗",
		})
	}

	if phrases == nil {
		phrases = []TransitionPhrase{}
	}

	return c.JSON(fiber.Map{
		"data":  phrases,
		"error": nil,
	})
}

// CachePhrase 從 Redis 取得已快取的過渡語音訊（<200ms 回應）
func (h *TransitionHandler) CachePhrase(c *fiber.Ctx) error {
	var req CachePhraseRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Language == "" {
		req.Language = "zh-TW"
	}
	if req.Style == "" {
		req.Style = "natural"
	}
	if req.VoiceGender == "" {
		req.VoiceGender = "female"
	}

	// 先查 Redis 快取
	cacheKey := "transition:" + req.Language + ":" + req.Style + ":" + req.VoiceGender
	ctx := context.Background()

	cached, err := h.rdb.Get(ctx, cacheKey).Result()
	if err == nil && cached != "" {
		var phrase TransitionPhrase
		if json.Unmarshal([]byte(cached), &phrase) == nil {
			return c.JSON(fiber.Map{
				"data":  phrase,
				"error": nil,
			})
		}
	}

	// Redis 沒有，從 DB 隨機取一筆已快取的
	var phrase TransitionPhrase
	err = h.db.Get(&phrase,
		`SELECT * FROM transition_phrases
		 WHERE language = $1 AND style = $2 AND voice_gender = $3
		   AND is_cached = TRUE AND deleted_at IS NULL
		 ORDER BY RANDOM() LIMIT 1`,
		req.Language, req.Style, req.VoiceGender,
	)
	if err != nil {
		// 沒有已快取的，取任意一筆
		err = h.db.Get(&phrase,
			`SELECT * FROM transition_phrases
			 WHERE language = $1 AND style = $2 AND deleted_at IS NULL
			 ORDER BY RANDOM() LIMIT 1`,
			req.Language, req.Style,
		)
		if err != nil {
			return c.JSON(fiber.Map{
				"data":  nil,
				"error": nil,
			})
		}
	}

	// 寫入 Redis 快取（5 分鐘過期，下次換一句）
	phraseJSON, _ := json.Marshal(phrase)
	h.rdb.Set(ctx, cacheKey, string(phraseJSON), 5*time.Minute)

	return c.JSON(fiber.Map{
		"data":  phrase,
		"error": nil,
	})
}

// SeedDefaultPhrases 種入預設過渡語（啟動時呼叫）
func SeedDefaultPhrases(db *sqlx.DB) {
	phrases := []struct {
		Language string
		Style    string
		Phrase   string
	}{
		// 繁體中文 — 自然風格
		{"zh-TW", "natural", "嗯，讓我想一下"},
		{"zh-TW", "natural", "好的，我來回答"},
		{"zh-TW", "natural", "嗯..."},
		{"zh-TW", "natural", "好問題"},
		{"zh-TW", "natural", "讓我想想"},
		{"zh-TW", "natural", "這個嘛..."},
		// 繁體中文 — 正式風格
		{"zh-TW", "formal", "好的，針對這個問題"},
		{"zh-TW", "formal", "讓我說明一下"},
		{"zh-TW", "formal", "關於這點"},
		{"zh-TW", "formal", "容我回覆"},
		// 英文 — 自然風格
		{"en-US", "natural", "Well, let me think..."},
		{"en-US", "natural", "That's a good question"},
		{"en-US", "natural", "Hmm..."},
		{"en-US", "natural", "Let me see..."},
	}

	for _, p := range phrases {
		// 不重複插入
		var exists bool
		db.Get(&exists,
			`SELECT EXISTS(SELECT 1 FROM transition_phrases WHERE language = $1 AND style = $2 AND phrase = $3 AND deleted_at IS NULL)`,
			p.Language, p.Style, p.Phrase,
		)
		if exists {
			continue
		}
		db.Exec(
			`INSERT INTO transition_phrases (language, style, phrase) VALUES ($1, $2, $3)`,
			p.Language, p.Style, p.Phrase,
		)
	}
}
