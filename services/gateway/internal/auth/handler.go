package auth

import (
	"database/sql"
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	db *sqlx.DB
}

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type User struct {
	ID                  uuid.UUID    `db:"id" json:"id"`
	Email               string       `db:"email" json:"email"`
	PasswordHash        string       `db:"password_hash" json:"-"`
	Name                *string      `db:"name" json:"name"`
	Plan                string       `db:"plan" json:"plan"`
	StripeCustomerID    *string      `db:"stripe_customer_id" json:"-"`
	IsLocked            bool         `db:"is_locked" json:"-"`
	FailedLoginAttempts int          `db:"failed_login_attempts" json:"-"`
	CreatedAt           time.Time    `db:"created_at" json:"created_at"`
	UpdatedAt           time.Time    `db:"updated_at" json:"updated_at"`
	DeletedAt           *time.Time   `db:"deleted_at" json:"-"`
}

func NewHandler(db *sqlx.DB) *Handler {
	return &Handler{db: db}
}

// Register 用戶註冊
func (h *Handler) Register(c *fiber.Ctx) error {
	var req RegisterRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	// 驗證必填欄位
	if req.Email == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Email 和密碼為必填",
		})
	}

	// 密碼長度檢查
	if len(req.Password) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "密碼至少 8 個字元",
		})
	}

	// 密碼 hash
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 寫入資料庫
	var user User
	err = h.db.QueryRowx(
		`INSERT INTO users (email, password_hash, name)
		 VALUES ($1, $2, $3)
		 RETURNING id, email, name, plan, created_at, updated_at`,
		req.Email, string(hashedPassword), req.Name,
	).StructScan(&user)

	if err != nil {
		// 檢查是否是重複 email
		if isDuplicateKeyError(err) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"data":  nil,
				"error": "此 Email 已被註冊",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "註冊失敗",
		})
	}

	// 產生 JWT
	token, err := generateToken(user.ID.String())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 產生失敗",
		})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"data": fiber.Map{
			"user":  user,
			"token": token,
		},
		"error": nil,
	})
}

// Login 用戶登入
func (h *Handler) Login(c *fiber.Ctx) error {
	var req LoginRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Email == "" || req.Password == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Email 和密碼為必填",
		})
	}

	// 查詢用戶（包含軟刪除檢查）
	var user User
	err := h.db.Get(&user,
		`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
		req.Email,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"data":  nil,
				"error": "Email 或密碼錯誤",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 檢查帳號是否被鎖定
	if user.IsLocked {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
			"data":  nil,
			"error": "帳號已被鎖定，請聯絡客服",
		})
	}

	// 驗證密碼
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		// 增加失敗計數
		newAttempts := user.FailedLoginAttempts + 1
		isLocked := newAttempts >= 5

		h.db.Exec(
			`UPDATE users SET failed_login_attempts = $1, is_locked = $2, updated_at = NOW() WHERE id = $3`,
			newAttempts, isLocked, user.ID,
		)

		if isLocked {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{
				"data":  nil,
				"error": "登入失敗次數過多，帳號已被鎖定",
			})
		}

		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "Email 或密碼錯誤",
		})
	}

	// 登入成功，重設失敗計數
	h.db.Exec(
		`UPDATE users SET failed_login_attempts = 0, updated_at = NOW() WHERE id = $1`,
		user.ID,
	)

	// 產生 JWT
	token, err := generateToken(user.ID.String())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 產生失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"user":  user,
			"token": token,
		},
		"error": nil,
	})
}

// RefreshToken 重新整理 JWT
func (h *Handler) RefreshToken(c *fiber.Ctx) error {
	// TODO: 實作 refresh token 邏輯
	return c.Status(fiber.StatusNotImplemented).JSON(fiber.Map{
		"data":  nil,
		"error": "尚未實作",
	})
}

// generateToken 產生 JWT Access Token
func generateToken(userID string) (string, error) {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-secret-key-at-least-32-characters-long"
	}

	claims := jwt.MapClaims{
		"sub": userID,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(15 * time.Minute).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// isDuplicateKeyError 檢查是否是 PostgreSQL 唯一鍵衝突
func isDuplicateKeyError(err error) bool {
	return err != nil && (
		// pgx 錯誤碼 23505 = unique_violation
		contains(err.Error(), "23505") ||
		contains(err.Error(), "duplicate key"))
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
