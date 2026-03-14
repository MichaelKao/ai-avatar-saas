package handlers

import (
	"database/sql"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// UserProfileHandler 用戶場景背景處理器
type UserProfileHandler struct {
	db *sqlx.DB
}

// UserProfile 用戶場景背景結構
type UserProfile struct {
	ID               uuid.UUID  `db:"id" json:"id"`
	SceneID          uuid.UUID  `db:"scene_id" json:"scene_id"`
	UserID           uuid.UUID  `db:"user_id" json:"user_id"`
	DisplayName      *string    `db:"display_name" json:"display_name"`
	Title            *string    `db:"title" json:"title"`
	Company          *string    `db:"company" json:"company"`
	ExperienceYears  int        `db:"experience_years" json:"experience_years"`
	Skills           *string    `db:"skills" json:"skills"`
	Experiences      *string    `db:"experiences" json:"experiences"`
	CustomPhrases    *string    `db:"custom_phrases" json:"custom_phrases"`
	AdditionalContext *string   `db:"additional_context" json:"additional_context"`
	CreatedAt        time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt        time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt        *time.Time `db:"deleted_at" json:"-"`
}

// UpsertProfileRequest 建立/更新用戶背景請求
type UpsertProfileRequest struct {
	DisplayName       *string `json:"display_name"`
	Title             *string `json:"title"`
	Company           *string `json:"company"`
	ExperienceYears   *int    `json:"experience_years"`
	Skills            *string `json:"skills"`
	Experiences       *string `json:"experiences"`
	CustomPhrases     *string `json:"custom_phrases"`
	AdditionalContext *string `json:"additional_context"`
}

// NewUserProfileHandler 建立 UserProfileHandler
func NewUserProfileHandler(db *sqlx.DB) *UserProfileHandler {
	return &UserProfileHandler{db: db}
}

// Get 取得場景的用戶背景
func (h *UserProfileHandler) Get(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("sceneId")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var profile UserProfile
	err := h.db.Get(&profile,
		`SELECT * FROM user_profiles WHERE scene_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		sceneID, userID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			// 沒有 profile 回傳空物件
			return c.JSON(fiber.Map{
				"data":  nil,
				"error": nil,
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶背景失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  profile,
		"error": nil,
	})
}

// Upsert 建立或更新用戶背景（一個場景只有一個 profile）
func (h *UserProfileHandler) Upsert(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("sceneId")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var req UpsertProfileRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	// 檢查是否已存在
	var existing UserProfile
	err := h.db.Get(&existing,
		`SELECT * FROM user_profiles WHERE scene_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		sceneID, userID,
	)

	if err == sql.ErrNoRows {
		// 建立新的
		expYears := 0
		if req.ExperienceYears != nil {
			expYears = *req.ExperienceYears
		}

		var profile UserProfile
		err := h.db.QueryRowx(
			`INSERT INTO user_profiles (scene_id, user_id, display_name, title, company,
			 experience_years, skills, experiences, custom_phrases, additional_context)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
			sceneID, userID, req.DisplayName, req.Title, req.Company,
			expYears, req.Skills, req.Experiences, req.CustomPhrases, req.AdditionalContext,
		).StructScan(&profile)

		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"data":  nil,
				"error": "建立用戶背景失敗",
			})
		}

		return c.Status(fiber.StatusCreated).JSON(fiber.Map{
			"data":  profile,
			"error": nil,
		})
	} else if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶背景失敗",
		})
	}

	// 更新現有的
	if req.DisplayName != nil {
		existing.DisplayName = req.DisplayName
	}
	if req.Title != nil {
		existing.Title = req.Title
	}
	if req.Company != nil {
		existing.Company = req.Company
	}
	if req.ExperienceYears != nil {
		existing.ExperienceYears = *req.ExperienceYears
	}
	if req.Skills != nil {
		existing.Skills = req.Skills
	}
	if req.Experiences != nil {
		existing.Experiences = req.Experiences
	}
	if req.CustomPhrases != nil {
		existing.CustomPhrases = req.CustomPhrases
	}
	if req.AdditionalContext != nil {
		existing.AdditionalContext = req.AdditionalContext
	}

	var updated UserProfile
	err = h.db.QueryRowx(
		`UPDATE user_profiles SET display_name = $1, title = $2, company = $3,
		 experience_years = $4, skills = $5, experiences = $6, custom_phrases = $7,
		 additional_context = $8, updated_at = NOW()
		 WHERE scene_id = $9 AND user_id = $10 AND deleted_at IS NULL RETURNING *`,
		existing.DisplayName, existing.Title, existing.Company,
		existing.ExperienceYears, existing.Skills, existing.Experiences,
		existing.CustomPhrases, existing.AdditionalContext, sceneID, userID,
	).StructScan(&updated)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新用戶背景失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  updated,
		"error": nil,
	})
}
