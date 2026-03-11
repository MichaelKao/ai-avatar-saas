package handlers

import (
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jmoiron/sqlx"
	"github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/webhook"
)

// WebhookHandler Webhook 處理器
type WebhookHandler struct {
	db *sqlx.DB
}

// NewWebhookHandler 建立 WebhookHandler 實例
func NewWebhookHandler(db *sqlx.DB) *WebhookHandler {
	return &WebhookHandler{db: db}
}

// HandleStripe 處理 Stripe Webhook 事件
func (h *WebhookHandler) HandleStripe(c *fiber.Ctx) error {
	// 取得 Webhook 簽名密鑰
	endpointSecret := os.Getenv("STRIPE_WEBHOOK_SECRET")
	if endpointSecret == "" {
		log.Println("警告: STRIPE_WEBHOOK_SECRET 未設定")
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "Webhook 設定錯誤",
		})
	}

	// 驗證 Stripe 簽名
	payload := c.Body()
	sigHeader := c.Get("Stripe-Signature")

	event, err := webhook.ConstructEvent(payload, sigHeader, endpointSecret)
	if err != nil {
		log.Printf("Stripe Webhook 簽名驗證失敗: %v", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Webhook 簽名驗證失敗",
		})
	}

	log.Printf("收到 Stripe 事件: %s", event.Type)

	// 根據事件類型處理
	switch event.Type {
	case "checkout.session.completed":
		return h.handleCheckoutCompleted(c, event)

	case "customer.subscription.updated":
		return h.handleSubscriptionUpdated(c, event)

	case "customer.subscription.deleted":
		return h.handleSubscriptionDeleted(c, event)

	default:
		log.Printf("未處理的 Stripe 事件類型: %s", event.Type)
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"received": true,
		},
		"error": nil,
	})
}

// handleCheckoutCompleted 處理結帳完成事件
func (h *WebhookHandler) handleCheckoutCompleted(c *fiber.Ctx, event stripe.Event) error {
	var checkoutSession stripe.CheckoutSession
	if err := json.Unmarshal(event.Data.Raw, &checkoutSession); err != nil {
		log.Printf("解析 checkout session 失敗: %v", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "事件資料解析失敗",
		})
	}

	userID := checkoutSession.ClientReferenceID
	customerID := checkoutSession.Customer.ID
	subscriptionID := checkoutSession.Subscription.ID

	if userID == "" {
		log.Println("checkout.session.completed: 缺少 client_reference_id")
		return c.JSON(fiber.Map{
			"data": fiber.Map{"received": true},
			"error": nil,
		})
	}

	// 更新用戶的 Stripe Customer ID
	_, err := h.db.Exec(
		`UPDATE users SET stripe_customer_id = $1, updated_at = NOW()
		 WHERE id = $2 AND deleted_at IS NULL`,
		customerID, userID,
	)
	if err != nil {
		log.Printf("更新用戶 Stripe Customer ID 失敗: %v", err)
	}

	// 判斷訂閱方案（根據金額或 price ID）
	plan := "pro" // 預設為 pro
	if checkoutSession.AmountTotal >= 9900 {
		plan = "enterprise"
	}

	// 更新用戶方案
	_, err = h.db.Exec(
		`UPDATE users SET plan = $1, updated_at = NOW()
		 WHERE id = $2 AND deleted_at IS NULL`,
		plan, userID,
	)
	if err != nil {
		log.Printf("更新用戶方案失敗: %v", err)
	}

	// 建立訂閱記錄
	now := time.Now()
	_, err = h.db.Exec(
		`INSERT INTO subscriptions (user_id, stripe_subscription_id, plan, status, current_period_start, created_at)
		 VALUES ($1, $2, $3, 'active', $4, $4)`,
		userID, subscriptionID, plan, now,
	)
	if err != nil {
		log.Printf("建立訂閱記錄失敗: %v", err)
	}

	log.Printf("用戶 %s 已成功訂閱 %s 方案", userID, plan)

	return c.JSON(fiber.Map{
		"data": fiber.Map{"received": true},
		"error": nil,
	})
}

// handleSubscriptionUpdated 處理訂閱更新事件
func (h *WebhookHandler) handleSubscriptionUpdated(c *fiber.Ctx, event stripe.Event) error {
	var sub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
		log.Printf("解析 subscription 失敗: %v", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "事件資料解析失敗",
		})
	}

	stripeSubID := sub.ID
	status := string(sub.Status)

	// 轉換時間
	periodStart := time.Unix(sub.CurrentPeriodStart, 0)
	periodEnd := time.Unix(sub.CurrentPeriodEnd, 0)

	// 更新本地訂閱記錄
	_, err := h.db.Exec(
		`UPDATE subscriptions
		 SET status = $1, current_period_start = $2, current_period_end = $3
		 WHERE stripe_subscription_id = $4`,
		status, periodStart, periodEnd, stripeSubID,
	)
	if err != nil {
		log.Printf("更新訂閱記錄失敗: %v", err)
	}

	log.Printf("訂閱 %s 狀態已更新為 %s", stripeSubID, status)

	return c.JSON(fiber.Map{
		"data": fiber.Map{"received": true},
		"error": nil,
	})
}

// handleSubscriptionDeleted 處理訂閱取消/刪除事件
func (h *WebhookHandler) handleSubscriptionDeleted(c *fiber.Ctx, event stripe.Event) error {
	var sub stripe.Subscription
	if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
		log.Printf("解析 subscription 失敗: %v", err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "事件資料解析失敗",
		})
	}

	stripeSubID := sub.ID

	// 更新訂閱狀態為 canceled
	_, err := h.db.Exec(
		`UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = $1`,
		stripeSubID,
	)
	if err != nil {
		log.Printf("更新訂閱狀態失敗: %v", err)
	}

	// 查詢對應的 user_id 並降級為 free
	var userID string
	err = h.db.Get(&userID,
		`SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1`,
		stripeSubID,
	)

	if err == nil && userID != "" {
		h.db.Exec(
			`UPDATE users SET plan = 'free', updated_at = NOW()
			 WHERE id = $1 AND deleted_at IS NULL`,
			userID,
		)
		log.Printf("用戶 %s 方案已降級為 free", userID)
	}

	log.Printf("訂閱 %s 已取消", stripeSubID)

	return c.JSON(fiber.Map{
		"data": fiber.Map{"received": true},
		"error": nil,
	})
}
