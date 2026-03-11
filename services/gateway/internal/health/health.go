package health

import (
	"context"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
	"github.com/redis/go-redis/v9"
)

type Handler struct {
	db  *sqlx.DB
	rdb *redis.Client
}

func NewHandler(db *sqlx.DB, rdb *redis.Client) *Handler {
	return &Handler{db: db, rdb: rdb}
}

// Basic 基本健康檢查（Railway 用）
func (h *Handler) Basic(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status":  "ok",
		"service": "ai-avatar-gateway",
	})
}

// Ready 深度檢查（含 DB + Redis）
func (h *Handler) Ready(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 檢查 PostgreSQL
	dbStatus := "connected"
	if err := h.db.PingContext(ctx); err != nil {
		dbStatus = "disconnected"
	}

	// 檢查 Redis
	redisStatus := "connected"
	if err := h.rdb.Ping(ctx).Err(); err != nil {
		redisStatus = "disconnected"
	}

	status := "ok"
	statusCode := fiber.StatusOK
	if dbStatus != "connected" || redisStatus != "connected" {
		status = "degraded"
		statusCode = fiber.StatusServiceUnavailable
	}

	return c.Status(statusCode).JSON(fiber.Map{
		"status":   status,
		"database": dbStatus,
		"redis":    redisStatus,
	})
}
