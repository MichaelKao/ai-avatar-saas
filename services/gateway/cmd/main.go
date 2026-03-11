package main

import (
	"fmt"
	"log"
	"os"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/joho/godotenv"

	"github.com/ai-avatar-saas/gateway/internal/auth"
	"github.com/ai-avatar-saas/gateway/internal/cache"
	"github.com/ai-avatar-saas/gateway/internal/database"
	"github.com/ai-avatar-saas/gateway/internal/handlers"
	"github.com/ai-avatar-saas/gateway/internal/health"
	"github.com/ai-avatar-saas/gateway/internal/middleware"
)

func main() {
	// 載入 .env（開發環境用）
	godotenv.Load()

	// 建立上傳目錄
	if err := os.MkdirAll("./uploads", 0755); err != nil {
		log.Fatalf("建立上傳目錄失敗: %v", err)
	}

	// 初始化資料庫
	db, err := database.Connect()
	if err != nil {
		log.Fatalf("資料庫連線失敗: %v", err)
	}
	defer db.Close()

	// 初始化 Redis
	rdb, err := cache.Connect()
	if err != nil {
		log.Fatalf("Redis 連線失敗: %v", err)
	}
	defer rdb.Close()

	// 執行資料庫 migration
	if err := database.Migrate(db); err != nil {
		log.Fatalf("資料庫 migration 失敗: %v", err)
	}

	// 建立 Fiber app
	app := fiber.New(fiber.Config{
		ErrorHandler: customErrorHandler,
		AppName:      "AI Avatar SaaS Gateway",
		BodyLimit:    50 * 1024 * 1024, // 50MB（語音檔案上傳用）
	})

	// 中間件
	app.Use(recover.New())
	app.Use(logger.New())
	corsOrigins := getEnv("CORS_ORIGINS", "http://localhost:3000")
	app.Use(cors.New(cors.Config{
		AllowOrigins:     corsOrigins,
		AllowMethods:     "GET,POST,PUT,DELETE,OPTIONS",
		AllowHeaders:     "Origin,Content-Type,Accept,Authorization",
		AllowCredentials: corsOrigins != "*",
	}))

	// 速率限制
	app.Use(middleware.RateLimiter())

	// 靜態檔案（上傳目錄）
	app.Static("/uploads", "./uploads")

	// 健康檢查（不需要認證）
	healthHandler := health.NewHandler(db, rdb)
	app.Get("/health", healthHandler.Basic)
	app.Get("/health/ready", healthHandler.Ready)

	// API v1 路由
	api := app.Group("/api/v1")

	// 認證路由（不需要 JWT）
	authHandler := auth.NewHandler(db)
	authGroup := api.Group("/auth")
	authGroup.Post("/register", authHandler.Register)
	authGroup.Post("/login", authHandler.Login)
	authGroup.Post("/refresh", authHandler.RefreshToken)

	// Stripe Webhook（不需要 JWT，但驗證 Stripe 簽名）
	webhookHandler := handlers.NewWebhookHandler(db)
	api.Post("/webhook/stripe", webhookHandler.HandleStripe)

	// 需要認證的路由
	protected := api.Group("", auth.JWTMiddleware())

	// Avatar 設定檔路由
	avatarHandler := handlers.NewAvatarHandler(db)
	avatarGroup := protected.Group("/avatar")
	avatarGroup.Get("/profile", avatarHandler.GetProfile)
	avatarGroup.Post("/upload-face", avatarHandler.UploadFace)
	avatarGroup.Post("/upload-voice", avatarHandler.UploadVoice)
	avatarGroup.Get("/model-status", avatarHandler.GetModelStatus)
	avatarGroup.Delete("/profile", avatarHandler.DeleteProfile)

	// AI 個性設定路由
	personalityHandler := handlers.NewPersonalityHandler(db)
	personalityGroup := protected.Group("/personality")
	personalityGroup.Get("/", personalityHandler.List)
	personalityGroup.Post("/", personalityHandler.Create)
	personalityGroup.Put("/:id", personalityHandler.Update)
	personalityGroup.Delete("/:id", personalityHandler.Delete)
	personalityGroup.Post("/:id/default", personalityHandler.SetDefault)

	// 會議 Session 路由
	sessionHandler := handlers.NewSessionHandler(db)
	sessionGroup := protected.Group("/session")
	sessionGroup.Post("/start", sessionHandler.StartSession)
	sessionGroup.Delete("/:id/end", sessionHandler.EndSession)
	sessionGroup.Get("/history", sessionHandler.GetHistory)

	// 帳務/訂閱路由
	billingHandler := handlers.NewBillingHandler(db)
	billingGroup := protected.Group("/billing")
	billingGroup.Get("/plans", billingHandler.GetPlans)
	billingGroup.Post("/subscribe", billingHandler.Subscribe)
	billingGroup.Post("/cancel", billingHandler.Cancel)
	billingGroup.Get("/status", billingHandler.GetStatus)
	billingGroup.Post("/portal", billingHandler.CreatePortalSession)

	// WebSocket 路由（含自訂 JWT 驗證）
	wsHandler := handlers.NewWebSocketHandler(db)
	app.Use("/ws", wsHandler.Upgrade())
	app.Get("/ws/session/:sessionId", wsHandler.HandleSession())

	// 啟動伺服器
	port := getEnv("PORT", "8080")
	log.Printf("Gateway 啟動在 port %s", port)
	log.Fatal(app.Listen(fmt.Sprintf(":%s", port)))
}

// customErrorHandler 統一錯誤處理
func customErrorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	if e, ok := err.(*fiber.Error); ok {
		code = e.Code
	}
	return c.Status(code).JSON(fiber.Map{
		"data":  nil,
		"error": err.Error(),
	})
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
