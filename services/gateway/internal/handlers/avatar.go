package handlers

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// AvatarHandler Avatar 設定檔相關處理器
type AvatarHandler struct {
	db *sqlx.DB
}

// AvatarProfile Avatar 設定檔結構
type AvatarProfile struct {
	ID               uuid.UUID  `db:"id" json:"id"`
	UserID           uuid.UUID  `db:"user_id" json:"user_id"`
	FaceImageURL     *string    `db:"face_image_url" json:"face_image_url"`
	VoiceSampleURL   *string    `db:"voice_sample_url" json:"voice_sample_url"`
	VoiceModelID     *string    `db:"voice_model_id" json:"voice_model_id"`
	FaceModelStatus  string     `db:"face_model_status" json:"face_model_status"`
	VoiceModelStatus string     `db:"voice_model_status" json:"voice_model_status"`
	CreatedAt        time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt        time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt        *time.Time `db:"deleted_at" json:"-"`
}

// NewAvatarHandler 建立 AvatarHandler 實例
func NewAvatarHandler(db *sqlx.DB) *AvatarHandler {
	return &AvatarHandler{db: db}
}

// GetProfile 取得用戶的 Avatar 設定檔（如不存在則自動建立）
func (h *AvatarHandler) GetProfile(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var profile AvatarProfile
	err := h.db.Get(&profile,
		`SELECT * FROM avatar_profiles WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			// 自動建立新的 Avatar 設定檔（使用預設值）
			defaultFace := "default"
			defaultVoice := "default"
			err = h.db.QueryRowx(
				`INSERT INTO avatar_profiles (user_id, face_image_url, voice_model_id, face_model_status, voice_model_status)
				 VALUES ($1, $2, $3, 'ready', 'ready')
				 RETURNING *`,
				userID, defaultFace, defaultVoice,
			).StructScan(&profile)

			if err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"data":  nil,
					"error": "建立 Avatar 設定檔失敗",
				})
			}

			return c.Status(fiber.StatusCreated).JSON(fiber.Map{
				"data":  profile,
				"error": nil,
			})
		}

		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "取得 Avatar 設定檔失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  profile,
		"error": nil,
	})
}

// UploadFace 上傳臉部圖片
func (h *AvatarHandler) UploadFace(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 取得上傳的檔案
	file, err := c.FormFile("face_image")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請上傳臉部圖片檔案（欄位名稱: face_image）",
		})
	}

	// 驗證檔案大小（最大 10MB）
	if file.Size > 10*1024*1024 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "檔案大小不得超過 10MB",
		})
	}

	// 產生唯一檔名並儲存
	ext := filepath.Ext(file.Filename)
	filename := fmt.Sprintf("%s_face_%d%s", userID, time.Now().UnixNano(), ext)
	savePath := filepath.Join(".", "uploads", filename)

	if err := c.SaveFile(file, savePath); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "檔案儲存失敗",
		})
	}

	// 組合存取 URL
	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	fileURL := fmt.Sprintf("%s/uploads/%s", baseURL, filename)

	// 確保 Avatar 設定檔存在，然後更新臉部圖片 URL
	_, err = h.db.Exec(
		`INSERT INTO avatar_profiles (user_id, face_image_url, face_model_status)
		 VALUES ($1, $2, 'processing')
		 ON CONFLICT (user_id) WHERE deleted_at IS NULL
		 DO UPDATE SET face_image_url = $2, face_model_status = 'processing', updated_at = NOW()`,
		userID, fileURL,
	)

	// 如果 ON CONFLICT 不適用（因為沒有 unique constraint on user_id），改用查詢更新
	if err != nil {
		// 嘗試直接更新
		result, updateErr := h.db.Exec(
			`UPDATE avatar_profiles SET face_image_url = $1, face_model_status = 'processing', updated_at = NOW()
			 WHERE user_id = $2 AND deleted_at IS NULL`,
			fileURL, userID,
		)

		if updateErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"data":  nil,
				"error": "更新臉部圖片失敗",
			})
		}

		rowsAffected, _ := result.RowsAffected()
		if rowsAffected == 0 {
			// 設定檔不存在，建立新的
			_, insertErr := h.db.Exec(
				`INSERT INTO avatar_profiles (user_id, face_image_url, face_model_status)
				 VALUES ($1, $2, 'processing')`,
				userID, fileURL,
			)
			if insertErr != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"data":  nil,
					"error": "建立 Avatar 設定檔失敗",
				})
			}
		}
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"face_image_url":    fileURL,
			"face_model_status": "processing",
		},
		"error": nil,
	})
}

// UploadVoice 上傳語音樣本
func (h *AvatarHandler) UploadVoice(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 取得上傳的檔案
	file, err := c.FormFile("voice_sample")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請上傳語音樣本檔案（欄位名稱: voice_sample）",
		})
	}

	// 驗證檔案大小（最大 50MB）
	if file.Size > 50*1024*1024 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "檔案大小不得超過 50MB",
		})
	}

	// 產生唯一檔名並儲存
	ext := filepath.Ext(file.Filename)
	filename := fmt.Sprintf("%s_voice_%d%s", userID, time.Now().UnixNano(), ext)
	savePath := filepath.Join(".", "uploads", filename)

	if err := c.SaveFile(file, savePath); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "檔案儲存失敗",
		})
	}

	// 組合存取 URL
	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	fileURL := fmt.Sprintf("%s/uploads/%s", baseURL, filename)

	// 更新語音樣本 URL
	result, err := h.db.Exec(
		`UPDATE avatar_profiles SET voice_sample_url = $1, voice_model_status = 'processing', updated_at = NOW()
		 WHERE user_id = $2 AND deleted_at IS NULL`,
		fileURL, userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新語音樣本失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		// 設定檔不存在，建立新的
		_, insertErr := h.db.Exec(
			`INSERT INTO avatar_profiles (user_id, voice_sample_url, voice_model_status)
			 VALUES ($1, $2, 'processing')`,
			userID, fileURL,
		)
		if insertErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"data":  nil,
				"error": "建立 Avatar 設定檔失敗",
			})
		}
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"voice_sample_url":   fileURL,
			"voice_model_status": "processing",
		},
		"error": nil,
	})
}

// GetModelStatus 取得臉部/語音模型處理狀態
func (h *AvatarHandler) GetModelStatus(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var profile AvatarProfile
	err := h.db.Get(&profile,
		`SELECT * FROM avatar_profiles WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "Avatar 設定檔不存在",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢模型狀態失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"face_model_status":  profile.FaceModelStatus,
			"voice_model_status": profile.VoiceModelStatus,
			"face_image_url":     profile.FaceImageURL,
			"voice_sample_url":   profile.VoiceSampleURL,
		},
		"error": nil,
	})
}

// DeleteProfile 軟刪除 Avatar 設定檔
func (h *AvatarHandler) DeleteProfile(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	result, err := h.db.Exec(
		`UPDATE avatar_profiles SET deleted_at = NOW(), updated_at = NOW()
		 WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "刪除 Avatar 設定檔失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "Avatar 設定檔不存在",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "Avatar 設定檔已刪除",
		},
		"error": nil,
	})
}

// SetDefaults 將用戶的 Avatar 設定恢復為預設值
func (h *AvatarHandler) SetDefaults(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	defaultFace := "default"
	defaultVoice := "default"

	// 嘗試更新現有設定檔
	result, err := h.db.Exec(
		`UPDATE avatar_profiles
		 SET face_image_url = $1, voice_model_id = $2,
		     face_model_status = 'ready', voice_model_status = 'ready',
		     updated_at = NOW()
		 WHERE user_id = $3 AND deleted_at IS NULL`,
		defaultFace, defaultVoice, userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "恢復預設值失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		// 設定檔不存在，建立新的並使用預設值
		_, insertErr := h.db.Exec(
			`INSERT INTO avatar_profiles (user_id, face_image_url, voice_model_id, face_model_status, voice_model_status)
			 VALUES ($1, $2, $3, 'ready', 'ready')`,
			userID, defaultFace, defaultVoice,
		)
		if insertErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"data":  nil,
				"error": "建立預設 Avatar 設定檔失敗",
			})
		}
	}

	// 回傳更新後的設定檔
	var profile AvatarProfile
	err = h.db.Get(&profile,
		`SELECT * FROM avatar_profiles WHERE user_id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "取得更新後的設定檔失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  profile,
		"error": nil,
	})
}
