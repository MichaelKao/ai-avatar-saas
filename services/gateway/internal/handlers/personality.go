package handlers

import (
	"database/sql"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// PersonalityHandler AI 個性設定相關處理器
type PersonalityHandler struct {
	db *sqlx.DB
}

// Personality AI 個性設定結構
type Personality struct {
	ID           uuid.UUID  `db:"id" json:"id"`
	UserID       uuid.UUID  `db:"user_id" json:"user_id"`
	Name         string     `db:"name" json:"name"`
	SystemPrompt string     `db:"system_prompt" json:"system_prompt"`
	LLMModel     string     `db:"llm_model" json:"llm_model"`
	Temperature  float64    `db:"temperature" json:"temperature"`
	Language     string     `db:"language" json:"language"`
	IsDefault    bool       `db:"is_default" json:"is_default"`
	CreatedAt    time.Time  `db:"created_at" json:"created_at"`
	DeletedAt    *time.Time `db:"deleted_at" json:"-"`
}

// CreatePersonalityRequest 建立個性設定請求
type CreatePersonalityRequest struct {
	Name         string  `json:"name"`
	SystemPrompt string  `json:"system_prompt"`
	LLMModel     string  `json:"llm_model"`
	Temperature  float64 `json:"temperature"`
	Language     string  `json:"language"`
}

// UpdatePersonalityRequest 更新個性設定請求
type UpdatePersonalityRequest struct {
	Name         *string  `json:"name"`
	SystemPrompt *string  `json:"system_prompt"`
	LLMModel     *string  `json:"llm_model"`
	Temperature  *float64 `json:"temperature"`
	Language     *string  `json:"language"`
}

// NewPersonalityHandler 建立 PersonalityHandler 實例
func NewPersonalityHandler(db *sqlx.DB) *PersonalityHandler {
	return &PersonalityHandler{db: db}
}

// List 列出用戶所有個性設定
func (h *PersonalityHandler) List(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var personalities []Personality
	err := h.db.Select(&personalities,
		`SELECT * FROM ai_personalities WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
		userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢個性設定失敗",
		})
	}

	// 確保回傳空陣列而非 null
	if personalities == nil {
		personalities = []Personality{}
	}

	return c.JSON(fiber.Map{
		"data":  personalities,
		"error": nil,
	})
}

// Create 建立新的個性設定
func (h *PersonalityHandler) Create(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var req CreatePersonalityRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	// 驗證必填欄位
	if req.Name == "" || req.SystemPrompt == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "名稱和系統提示詞為必填",
		})
	}

	// 設定預設值
	if req.LLMModel == "" {
		req.LLMModel = "claude-sonnet-4-20250514"
	}
	if req.Temperature == 0 {
		req.Temperature = 0.7
	}
	if req.Language == "" {
		req.Language = "zh-TW"
	}

	// 檢查是否為用戶第一個個性設定（自動設為預設）
	var count int
	h.db.Get(&count,
		`SELECT COUNT(*) FROM ai_personalities WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)
	isDefault := count == 0

	var personality Personality
	err := h.db.QueryRowx(
		`INSERT INTO ai_personalities (user_id, name, system_prompt, llm_model, temperature, language, is_default)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING *`,
		userID, req.Name, req.SystemPrompt, req.LLMModel, req.Temperature, req.Language, isDefault,
	).StructScan(&personality)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立個性設定失敗",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"data":  personality,
		"error": nil,
	})
}

// Update 更新個性設定
func (h *PersonalityHandler) Update(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	personalityID := c.Params("id")

	// 驗證 UUID 格式
	if _, err := uuid.Parse(personalityID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的個性設定 ID",
		})
	}

	var req UpdatePersonalityRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	// 確認個性設定存在且屬於該用戶
	var existing Personality
	err := h.db.Get(&existing,
		`SELECT * FROM ai_personalities WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		personalityID, userID,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "個性設定不存在",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢個性設定失敗",
		})
	}

	// 套用更新（僅更新有提供的欄位）
	if req.Name != nil {
		existing.Name = *req.Name
	}
	if req.SystemPrompt != nil {
		existing.SystemPrompt = *req.SystemPrompt
	}
	if req.LLMModel != nil {
		existing.LLMModel = *req.LLMModel
	}
	if req.Temperature != nil {
		existing.Temperature = *req.Temperature
	}
	if req.Language != nil {
		existing.Language = *req.Language
	}

	var updated Personality
	err = h.db.QueryRowx(
		`UPDATE ai_personalities
		 SET name = $1, system_prompt = $2, llm_model = $3, temperature = $4, language = $5
		 WHERE id = $6 AND user_id = $7 AND deleted_at IS NULL
		 RETURNING *`,
		existing.Name, existing.SystemPrompt, existing.LLMModel,
		existing.Temperature, existing.Language, personalityID, userID,
	).StructScan(&updated)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新個性設定失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  updated,
		"error": nil,
	})
}

// Delete 軟刪除個性設定
func (h *PersonalityHandler) Delete(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	personalityID := c.Params("id")

	// 驗證 UUID 格式
	if _, err := uuid.Parse(personalityID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的個性設定 ID",
		})
	}

	result, err := h.db.Exec(
		`UPDATE ai_personalities SET deleted_at = NOW()
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		personalityID, userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "刪除個性設定失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "個性設定不存在",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "個性設定已刪除",
		},
		"error": nil,
	})
}

// SetDefault 設定為預設個性
func (h *PersonalityHandler) SetDefault(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	personalityID := c.Params("id")

	// 驗證 UUID 格式
	if _, err := uuid.Parse(personalityID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的個性設定 ID",
		})
	}

	// 確認目標個性設定存在
	var exists bool
	err := h.db.Get(&exists,
		`SELECT EXISTS(SELECT 1 FROM ai_personalities WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)`,
		personalityID, userID,
	)

	if err != nil || !exists {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "個性設定不存在",
		})
	}

	// 先將所有個性設定取消預設
	_, err = h.db.Exec(
		`UPDATE ai_personalities SET is_default = FALSE
		 WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新預設設定失敗",
		})
	}

	// 設定目標為預設
	_, err = h.db.Exec(
		`UPDATE ai_personalities SET is_default = TRUE
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		personalityID, userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "設定預設個性失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "已設定為預設個性",
		},
		"error": nil,
	})
}
