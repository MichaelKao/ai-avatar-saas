package handlers

import (
	"database/sql"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

// KnowledgeBaseHandler 知識庫處理器
type KnowledgeBaseHandler struct {
	db *sqlx.DB
}

// KnowledgeBase 知識庫結構
type KnowledgeBase struct {
	ID          uuid.UUID  `db:"id" json:"id"`
	SceneID     uuid.UUID  `db:"scene_id" json:"scene_id"`
	UserID      uuid.UUID  `db:"user_id" json:"user_id"`
	Title       string     `db:"title" json:"title"`
	Content     string     `db:"content" json:"content"`
	ContentType string     `db:"content_type" json:"content_type"`
	FileURL     *string    `db:"file_url" json:"file_url"`
	TokenCount  int        `db:"token_count" json:"token_count"`
	CreatedAt   time.Time  `db:"created_at" json:"created_at"`
	UpdatedAt   time.Time  `db:"updated_at" json:"updated_at"`
	DeletedAt   *time.Time `db:"deleted_at" json:"-"`
}

// CreateKBRequest 建立知識庫請求
type CreateKBRequest struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	ContentType string `json:"content_type"`
}

// UpdateKBRequest 更新知識庫請求
type UpdateKBRequest struct {
	Title   *string `json:"title"`
	Content *string `json:"content"`
}

// NewKnowledgeBaseHandler 建立 KnowledgeBaseHandler
func NewKnowledgeBaseHandler(db *sqlx.DB) *KnowledgeBaseHandler {
	return &KnowledgeBaseHandler{db: db}
}

// List 列出場景的所有知識庫
func (h *KnowledgeBaseHandler) List(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("sceneId")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var items []KnowledgeBase
	err := h.db.Select(&items,
		`SELECT * FROM knowledge_bases WHERE scene_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC`,
		sceneID, userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢知識庫失敗",
		})
	}

	if items == nil {
		items = []KnowledgeBase{}
	}

	return c.JSON(fiber.Map{
		"data":  items,
		"error": nil,
	})
}

// Create 建立知識庫條目
func (h *KnowledgeBaseHandler) Create(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	sceneID := c.Params("sceneId")

	if _, err := uuid.Parse(sceneID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的場景 ID",
		})
	}

	var req CreateKBRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Title == "" || req.Content == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "標題和內容為必填",
		})
	}

	if req.ContentType == "" {
		req.ContentType = "text"
	}

	// 粗略計算 token 數（中文約 2 字元 = 1 token）
	tokenCount := len([]rune(req.Content)) / 2

	var item KnowledgeBase
	err := h.db.QueryRowx(
		`INSERT INTO knowledge_bases (scene_id, user_id, title, content, content_type, token_count)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
		sceneID, userID, req.Title, req.Content, req.ContentType, tokenCount,
	).StructScan(&item)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立知識庫失敗",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"data":  item,
		"error": nil,
	})
}

// Update 更新知識庫條目
func (h *KnowledgeBaseHandler) Update(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	itemID := c.Params("id")

	if _, err := uuid.Parse(itemID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的知識庫 ID",
		})
	}

	var req UpdateKBRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	var existing KnowledgeBase
	err := h.db.Get(&existing,
		`SELECT * FROM knowledge_bases WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		itemID, userID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "知識庫條目不存在",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢知識庫失敗",
		})
	}

	if req.Title != nil {
		existing.Title = *req.Title
	}
	if req.Content != nil {
		existing.Content = *req.Content
		existing.TokenCount = len([]rune(*req.Content)) / 2
	}

	var updated KnowledgeBase
	err = h.db.QueryRowx(
		`UPDATE knowledge_bases SET title = $1, content = $2, token_count = $3, updated_at = NOW()
		 WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL RETURNING *`,
		existing.Title, existing.Content, existing.TokenCount, itemID, userID,
	).StructScan(&updated)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "更新知識庫失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data":  updated,
		"error": nil,
	})
}

// Delete 軟刪除知識庫條目
func (h *KnowledgeBaseHandler) Delete(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)
	itemID := c.Params("id")

	if _, err := uuid.Parse(itemID); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的知識庫 ID",
		})
	}

	result, err := h.db.Exec(
		`UPDATE knowledge_bases SET deleted_at = NOW()
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
		itemID, userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "刪除知識庫失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "知識庫條目不存在",
		})
	}

	return c.JSON(fiber.Map{
		"data":  fiber.Map{"message": "知識庫條目已刪除"},
		"error": nil,
	})
}
