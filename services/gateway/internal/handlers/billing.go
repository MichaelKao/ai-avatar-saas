package handlers

import (
	"database/sql"
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/stripe/stripe-go/v81"
	billingportal "github.com/stripe/stripe-go/v81/billingportal/session"
	"github.com/stripe/stripe-go/v81/checkout/session"
	"github.com/stripe/stripe-go/v81/subscription"
)

// BillingHandler 帳務/訂閱相關處理器
type BillingHandler struct {
	db *sqlx.DB
}

// Subscription 訂閱記錄結構
type Subscription struct {
	ID                   uuid.UUID  `db:"id" json:"id"`
	UserID               uuid.UUID  `db:"user_id" json:"user_id"`
	StripeSubscriptionID *string    `db:"stripe_subscription_id" json:"stripe_subscription_id"`
	Plan                 string     `db:"plan" json:"plan"`
	Status               string     `db:"status" json:"status"`
	CurrentPeriodStart   *time.Time `db:"current_period_start" json:"current_period_start"`
	CurrentPeriodEnd     *time.Time `db:"current_period_end" json:"current_period_end"`
	CreatedAt            time.Time  `db:"created_at" json:"created_at"`
}

// Plan 方案結構
type Plan struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Price       int      `json:"price"`
	Currency    string   `json:"currency"`
	Interval    string   `json:"interval"`
	Features    []string `json:"features"`
	StripePriceID string `json:"stripe_price_id,omitempty"`
}

// SubscribeRequest 訂閱請求
type SubscribeRequest struct {
	PlanID string `json:"plan_id"`
}

// NewBillingHandler 建立 BillingHandler 實例
func NewBillingHandler(db *sqlx.DB) *BillingHandler {
	// 初始化 Stripe API Key
	stripe.Key = os.Getenv("STRIPE_SECRET_KEY")
	return &BillingHandler{db: db}
}

// GetPlans 取得所有可用方案
func (h *BillingHandler) GetPlans(c *fiber.Ctx) error {
	plans := []Plan{
		{
			ID:       "free",
			Name:     "Free",
			Price:    0,
			Currency: "usd",
			Interval: "month",
			Features: []string{
				"每日 30 分鐘會議時間",
				"基本 AI 個性",
				"標準畫質",
			},
		},
		{
			ID:            "pro",
			Name:          "Pro",
			Price:         2900,
			Currency:      "usd",
			Interval:      "month",
			StripePriceID: os.Getenv("STRIPE_PRICE_PRO"),
			Features: []string{
				"無限會議時間",
				"自訂 AI 個性",
				"高畫質串流",
				"語音克隆",
				"優先技術支援",
			},
		},
		{
			ID:            "enterprise",
			Name:          "Enterprise",
			Price:         9900,
			Currency:      "usd",
			Interval:      "month",
			StripePriceID: os.Getenv("STRIPE_PRICE_ENTERPRISE"),
			Features: []string{
				"Pro 方案所有功能",
				"多人同時使用",
				"API 存取",
				"自訂模型訓練",
				"專屬客戶經理",
				"SLA 保證",
			},
		},
	}

	return c.JSON(fiber.Map{
		"data":  plans,
		"error": nil,
	})
}

// Subscribe 建立 Stripe Checkout Session 進行訂閱
func (h *BillingHandler) Subscribe(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	var req SubscribeRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.PlanID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "方案 ID 為必填",
		})
	}

	// 取得對應的 Stripe Price ID
	priceIDMap := map[string]string{
		"pro":        os.Getenv("STRIPE_PRICE_PRO"),
		"enterprise": os.Getenv("STRIPE_PRICE_ENTERPRISE"),
	}

	priceID, ok := priceIDMap[req.PlanID]
	if !ok || priceID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "無效的方案 ID 或方案尚未設定",
		})
	}

	// 取得用戶 email 和 Stripe Customer ID
	var userEmail string
	var stripeCustomerID sql.NullString
	err := h.db.QueryRow(
		`SELECT email, stripe_customer_id FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	).Scan(&userEmail, &stripeCustomerID)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶資料失敗",
		})
	}

	// 組合前端回調 URL
	frontendURL := os.Getenv("FRONTEND_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:3000"
	}

	// 建立 Stripe Checkout Session 參數
	params := &stripe.CheckoutSessionParams{
		Mode: stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		LineItems: []*stripe.CheckoutSessionLineItemParams{
			{
				Price:    stripe.String(priceID),
				Quantity: stripe.Int64(1),
			},
		},
		SuccessURL:        stripe.String(frontendURL + "/billing/success?session_id={CHECKOUT_SESSION_ID}"),
		CancelURL:         stripe.String(frontendURL + "/billing/cancel"),
		CustomerEmail:     stripe.String(userEmail),
		ClientReferenceID: stripe.String(userID),
	}

	// 如果用戶已有 Stripe Customer ID，使用現有客戶
	if stripeCustomerID.Valid && stripeCustomerID.String != "" {
		params.CustomerEmail = nil
		params.Customer = stripe.String(stripeCustomerID.String)
	}

	// 建立 Checkout Session
	checkoutSession, err := session.New(params)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立付款頁面失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"checkout_url": checkoutSession.URL,
			"session_id":   checkoutSession.ID,
		},
		"error": nil,
	})
}

// Cancel 取消訂閱
func (h *BillingHandler) Cancel(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 查詢用戶的有效訂閱
	var sub Subscription
	err := h.db.Get(&sub,
		`SELECT * FROM subscriptions
		 WHERE user_id = $1 AND status = 'active'
		 ORDER BY created_at DESC LIMIT 1`,
		userID,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"data":  nil,
				"error": "沒有有效的訂閱",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢訂閱失敗",
		})
	}

	if sub.StripeSubscriptionID == nil || *sub.StripeSubscriptionID == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "訂閱資料異常",
		})
	}

	// 取消 Stripe 訂閱（在期末取消）
	_, err = subscription.Update(*sub.StripeSubscriptionID, &stripe.SubscriptionParams{
		CancelAtPeriodEnd: stripe.Bool(true),
	})

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "取消訂閱失敗",
		})
	}

	// 更新本地訂閱狀態
	h.db.Exec(
		`UPDATE subscriptions SET status = 'canceling' WHERE id = $1`,
		sub.ID,
	)

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message":    "訂閱已設定為在期末取消",
			"cancel_at":  sub.CurrentPeriodEnd,
		},
		"error": nil,
	})
}

// GetStatus 取得目前訂閱狀態
func (h *BillingHandler) GetStatus(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 查詢用戶方案
	var plan string
	err := h.db.Get(&plan,
		`SELECT plan FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶資料失敗",
		})
	}

	// 查詢訂閱記錄
	var sub Subscription
	err = h.db.Get(&sub,
		`SELECT * FROM subscriptions
		 WHERE user_id = $1 AND status IN ('active', 'canceling')
		 ORDER BY created_at DESC LIMIT 1`,
		userID,
	)

	if err != nil && err != sql.ErrNoRows {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢訂閱狀態失敗",
		})
	}

	// 計算本月使用量
	var monthSessions int64
	h.db.Get(&monthSessions,
		`SELECT COUNT(*)
		 FROM meeting_sessions
		 WHERE user_id = $1
		   AND started_at >= date_trunc('month', CURRENT_DATE)`,
		userID,
	)

	var monthDurationSeconds int64
	h.db.Get(&monthDurationSeconds,
		`SELECT COALESCE(SUM(duration_seconds), 0)
		 FROM meeting_sessions
		 WHERE user_id = $1
		   AND started_at >= date_trunc('month', CURRENT_DATE)
		   AND ended_at IS NOT NULL`,
		userID,
	)

	var monthResponses int64
	h.db.Get(&monthResponses,
		`SELECT COALESCE(SUM(total_responses), 0)
		 FROM meeting_sessions
		 WHERE user_id = $1
		   AND started_at >= date_trunc('month', CURRENT_DATE)`,
		userID,
	)

	totalMinutes := monthDurationSeconds / 60

	status := "active"
	var currentPeriodEnd *time.Time
	if err != sql.ErrNoRows {
		status = sub.Status
		currentPeriodEnd = sub.CurrentPeriodEnd
	}

	result := fiber.Map{
		"plan":               plan,
		"status":             status,
		"current_period_end": currentPeriodEnd,
		"usage_this_month": fiber.Map{
			"sessions":      monthSessions,
			"total_minutes":  totalMinutes,
			"suggestions":   monthResponses,
		},
	}

	return c.JSON(fiber.Map{
		"data":  result,
		"error": nil,
	})
}

// CreatePortalSession 建立 Stripe 客戶管理入口 Session
func (h *BillingHandler) CreatePortalSession(c *fiber.Ctx) error {
	userID := c.Locals("userID").(string)

	// 取得用戶的 Stripe Customer ID
	var stripeCustomerID sql.NullString
	err := h.db.Get(&stripeCustomerID,
		`SELECT stripe_customer_id FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	)

	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "查詢用戶資料失敗",
		})
	}

	if !stripeCustomerID.Valid || stripeCustomerID.String == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "尚未建立付款資訊，請先訂閱方案",
		})
	}

	frontendURL := os.Getenv("FRONTEND_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:3000"
	}

	// 建立 Stripe Billing Portal Session
	params := &stripe.BillingPortalSessionParams{
		Customer:  stripe.String(stripeCustomerID.String),
		ReturnURL: stripe.String(frontendURL + "/billing"),
	}

	portalSession, err := billingportal.New(params)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "建立管理頁面失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"portal_url": portalSession.URL,
		},
		"error": nil,
	})
}
