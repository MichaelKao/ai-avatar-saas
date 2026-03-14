package handlers

import (
	"database/sql"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// SceneHandler 場景管理處理器
type SceneHandler struct {
	db *sqlx.DB
}

// Scene 場景結構
type Scene struct {
	ID                 uuid.UUID  `db:"id" json:"id"`
	UserID             uuid.UUID  `db:"user_id" json:"user_id"`
	Name               string     `db:"name" json:"name"`
	SceneType          string     `db:"scene_type" json:"scene_type"`
	Language           string     `db:"language" json:"language"`
	ReplyLanguage      string     `db:"reply_language" json:"reply_language"`
	ReplyLength        string     `db:"reply_length" json:"reply_length"`
	Personality        string     `db:"personality" json:"personality"`
	Formality          int        `db:"formality" json:"formality"`
	CustomSystemPrompt *string    `db:"custom_system_prompt" json:"custom_system_prompt"`
	LLMModel           string     `db:"llm_model" json:"llm_model"`
	Temperature        float64    `db:"temperature" json:"temperature"`
	TransitionEnabled  bool       `db:"transition_enabled" json:"transition_enabled"`
	TransitionStyle    string     `db:"transition_style" json:"transition_style"`
	IsDefault          bool       `db:"is_default" json:"is_default"`
	CreatedAt          time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt          time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt          *time.Time `db:"deleted_at" json:"-"`
}

// CreateSceneRequest 建立場景請求
type CreateSceneRequest struct {
	Name               string  `json:"name"`
	SceneType          string  `json:"scene_type"`
	Language           string  `json:"language"`
	ReplyLanguage      string  `json:"reply_language"`
	ReplyLength        string  `json:"reply_length"`
	Personality        string  `json:"personality"`
	Formality          int     `json:"formality"`
	CustomSystemPrompt *string `json:"custom_system_prompt"`
	LLMModel           string  `json:"llm_model"`
	Temperature        float64 `json:"temperature"`
	TransitionEnabled  *bool   `json:"transition_enabled"`
	TransitionStyle    string  `json:"transition_style"`
}

// UpdateSceneRequest 更新場景請求
type UpdateSceneRequest struct {
	Name               *string  `json:"name"`
	SceneType          *string  `json:"scene_type"`
	Language           *string  `json:"language"`
	ReplyLanguage      *string  `json:"reply_language"`
	ReplyLength        *string  `json:"reply_length"`
	Personality        *string  `json:"personality"`
	Formality          *int     `json:"formality"`
	CustomSystemPrompt *string  `json:"custom_system_prompt"`
	LLMModel           *string  `json:"llm_model"`
	Temperature        *float64 `json:"temperature"`
	TransitionEnabled  *bool    `json:"transition_enabled"`
	TransitionStyle    *string  `json:"transition_style"`
}

// SceneTemplate 內建場景模板
type SceneTemplate struct {
	SceneType   string `json:"scene_type"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Personality string `json:"personality"`
	ReplyLength string `json:"reply_length"`
	Formality   int    `json:"formality"`
	Prompt      string `json:"default_system_prompt"`
}

// NewSceneHandler 建立 SceneHandler
func NewSceneHandler(db *sqlx.DB) *SceneHandler {
	return &SceneHandler{db: db}
}

// 內建場景模板
var sceneTemplates = []SceneTemplate{
	{
		SceneType:   "interview",
		Name:        "技術面試",
		Description: "專業面試場景，有自信地回答技術問題",
		Personality: "confident",
		ReplyLength: "medium",
		Formality:   4,
		Prompt:      "你是面試者本人。根據提供的個人背景和技能，以第一人稱回答面試問題。保持專業自信，適當舉例說明。回答控制在2-3句，使用 STAR 方法（情境、任務、行動、結果）。",
	},
	{
		SceneType:   "business_meeting",
		Name:        "商務會議",
		Description: "正式商務會議，數據導向的討論",
		Personality: "professional",
		ReplyLength: "medium",
		Formality:   4,
		Prompt:      "你是與會者本人。在商務會議中代表發言，風格正式、數據導向。回答控制在3-4句，引用具體數據和成果。使用商務用語。",
	},
	{
		SceneType:   "customer_service",
		Name:        "客戶服務",
		Description: "親切的客服應對，解決問題導向",
		Personality: "friendly",
		ReplyLength: "medium",
		Formality:   3,
		Prompt:      "你是客服人員。以親切、耐心的態度回答客戶問題。先確認理解問題，再提供解決方案。回答控制在2-3句。",
	},
	{
		SceneType:   "academic",
		Name:        "學術討論",
		Description: "嚴謹的學術討論，引用數據和研究",
		Personality: "rigorous",
		ReplyLength: "long",
		Formality:   5,
		Prompt:      "你是學術研究者。以嚴謹的態度參與學術討論，引用研究數據和文獻。回答控制在4-5句，使用學術用語。",
	},
	{
		SceneType:   "casual",
		Name:        "日常對話",
		Description: "輕鬆自然的日常聊天",
		Personality: "friendly",
		ReplyLength: "short",
		Formality:   1,
		Prompt:      "你是朋友。以輕鬆自然的方式聊天，不需要太正式。回答控制在1-2句。",
	},
	{
		SceneType:   "custom",
		Name:        "自訂場景",
		Description: "完全自訂所有設定",
		Personality: "professional",
		ReplyLength: "medium",
		Formality:   3,
		Prompt:      "你是AI助手。根據用戶的需求提供幫助。回答簡潔有力，使用繁體中文。",
	},
}

// GetTemplates 取得內建場景模板
func (h *SceneHandler) GetTemplates(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"data":  sceneTemplates,
		"error": nil,
	})
}

// List 列出用戶所有場景
func (h *SceneHandler) List(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var scenes []Scene
	err := h.db.Select(&scenes,
		`SELECT * FROM scenes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at DESC`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢場景失敗",
		})
	}

	if scenes == nil {
		scenes = []Scene{}
	}

	return c.JSON(fiber.Map{
		"data":  scenes,
		"error": nil,
	})
}

// Create 建立新場景
func (h *SceneHandler) Create(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var req CreateSceneRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Name == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "場景名稱為必填",
		})
	}

	// 預設值
	if req.SceneType == "" {
		req.SceneType = "custom"
	}
	if req.Language == "" {
		req.Language = "zh-TW"
	}
	if req.ReplyLanguage == "" {
		req.ReplyLanguage = req.Language
	}
	if req.ReplyLength == "" {
		req.ReplyLength = "medium"
	}
	if req.Personality == "" {
		req.Personality = "professional"
	}
	if req.Formality == 0 {
		req.Formality = 3
	}
	if req.LLMModel == "" {
		req.LLMModel = "claude-sonnet-4-6"
	}
	if req.Temperature == 0 {
		req.Temperature = 0.7
	}
	if req.TransitionStyle == "" {
		req.TransitionStyle = "natural"
	}
	transitionEnabled := true
	if req.TransitionEnabled != nil {
		transitionEnabled = *req.TransitionEnabled
	}

	// 如果用模板建立，套用模板預設 prompt
	if req.CustomSystemPrompt == nil && req.SceneType != "custom" {
		for _, t := range sceneTemplates {
			if t.SceneType == req.SceneType {
				req.CustomSystemPrompt = &t.Prompt
				break
			}
		}
	}

	// 第一個場景自動設為預設
	var count int
	h.db.Get(&count,
		`SELECT COUNT(*) FROM scenes WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)
	isDefault := count == 0

	var scene Scene
	err := h.db.QueryRowx(
		`INSERT INTO scenes (user_id, name, scene_type, language, reply_language, reply_length,
		 personality, formality, custom_system_prompt, llm_model, temperature,
		 transition_enabled, transition_style, is_default)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		 RETURNING *`,
		userID, req.Name, req.SceneType, req.Language, req.ReplyLanguage, req.ReplyLength,
		req.Personality, req.Formality, req.CustomSystemPrompt, req.LLMModel, req.Temperature,
		transitionEnabled, req.TransitionStyle, isDefault,
	).StructScan(&scene)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立場景失敗",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"data":  scene,
		"error": nil,
	})
}

// Update 更新場景
func (h *SceneHandler) Update(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("id")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var req UpdateSceneRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	var existing Scene
	err := h.db.Get(&existing,
		`SELECT * FROM scenes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		sceneID, userID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "場景不存在",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢場景失敗",
		})
	}

	// 套用更新
	if req.Name != nil {
		existing.Name = *req.Name
	}
	if req.SceneType != nil {
		existing.SceneType = *req.SceneType
	}
	if req.Language != nil {
		existing.Language = *req.Language
	}
	if req.ReplyLanguage != nil {
		existing.ReplyLanguage = *req.ReplyLanguage
	}
	if req.ReplyLength != nil {
		existing.ReplyLength = *req.ReplyLength
	}
	if req.Personality != nil {
		existing.Personality = *req.Personality
	}
	if req.Formality != nil {
		existing.Formality = *req.Formality
	}
	if req.CustomSystemPrompt != nil {
		existing.CustomSystemPrompt = req.CustomSystemPrompt
	}
	if req.LLMModel != nil {
		existing.LLMModel = *req.LLMModel
	}
	if req.Temperature != nil {
		existing.Temperature = *req.Temperature
	}
	if req.TransitionEnabled != nil {
		existing.TransitionEnabled = *req.TransitionEnabled
	}
	if req.TransitionStyle != nil {
		existing.TransitionStyle = *req.TransitionStyle
	}

	var updated Scene
	err = h.db.QueryRowx(
		`UPDATE scenes SET name = $1, scene_type = $2, language = $3, reply_language = $4,
		 reply_length = $5, personality = $6, formality = $7, custom_system_prompt = $8,
		 llm_model = $9, temperature = $10, transition_enabled = $11, transition_style = $12,
		 updated_at = NOW()
		 WHERE id = $13 AND user_id = $14 AND deleted_at IS NULL
		 RETURNING *`,
		existing.Name, existing.SceneType, existing.Language, existing.ReplyLanguage,
		existing.ReplyLength, existing.Personality, existing.Formality, existing.CustomSystemPrompt,
		existing.LLMModel, existing.Temperature, existing.TransitionEnabled, existing.TransitionStyle,
		sceneID, userID,
	).StructScan(&updated)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新場景失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  updated,
		"error": nil,
	})
}

// Delete 軟刪除場景
func (h *SceneHandler) Delete(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("id")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	result, err := h.db.Exec(
		`UPDATE scenes SET deleted_at = NOW()
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		sceneID, userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "刪除場景失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "場景不存在",
		})
	}

	return c.JSON(fiber.Map{
		"data":  fiber.Map{"message": "場景已刪除"},
		"error": nil,
	})
}

// SetDefault 設定為預設場景
func (h *SceneHandler) SetDefault(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("id")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var exists bool
	err := h.db.Get(&exists,
		`SELECT EXISTS(SELECT 1 FROM scenes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)`,
		sceneID, userID,
	)
	if err != nil || !exists {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "場景不存在",
		})
	}

	// 先取消所有預設
	h.db.Exec(
		`UPDATE scenes SET is_default = FALSE WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)

	// 設定目標為預設
	h.db.Exec(
		`UPDATE scenes SET is_default = TRUE WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		sceneID, userID,
	)

	return c.JSON(fiber.Map{
		"data":  fiber.Map{"message": "已設定為預設場景"},
		"error": nil,
	})
}
