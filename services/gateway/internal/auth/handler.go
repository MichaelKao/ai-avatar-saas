package auth

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"golang.org/x/crypto/bcrypt"

	"github.com/ai-avatar-saas/gateway/internal/email"
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

type RefreshTokenRequest struct {
	Token string `json:"token"`
}

type ForgotPasswordRequest struct {
	Email string `json:"email"`
}

type ResetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
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
	var req RefreshTokenRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Token == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 為必填",
		})
	}

	// 解析 JWT，允許已過期的 token（24 小時寬限期）
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-secret-key-at-least-32-characters-long"
	}

	token, err := jwt.Parse(req.Token, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("無效的簽名方法")
		}
		return []byte(secret), nil
	}, jwt.WithLeeway(24*time.Hour))

	if err != nil || !token.Valid {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 無效或已超過刷新期限",
		})
	}

	// 從 claims 取得 user ID
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 格式錯誤",
		})
	}

	userID, ok := claims["sub"].(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 中缺少用戶資訊",
		})
	}

	// 產生新的 JWT
	newToken, err := generateToken(userID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 產生失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"token": newToken,
		},
		"error": nil,
	})
}

// ForgotPassword 忘記密碼，發送重設 token
func (h *Handler) ForgotPassword(c *fiber.Ctx) error {
	var req ForgotPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	// 不管 email 是否存在都回傳成功（防止 email 列舉攻擊）
	successResponse := c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "如果該 Email 已註冊，將會收到密碼重設連結",
		},
		"error": nil,
	})

	if req.Email == "" {
		return successResponse
	}

	// 查詢用戶
	var user User
	err := h.db.Get(&user,
		`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
		req.Email,
	)
	if err != nil {
		// 用戶不存在也回傳成功
		return successResponse
	}

	// 產生隨機 reset token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}
	resetToken := hex.EncodeToString(tokenBytes)

	// 儲存到資料庫（1 小時過期）
	_, err = h.db.Exec(
		`INSERT INTO password_reset_tokens (user_id, token, expires_at)
		 VALUES ($1, $2, $3)`,
		user.ID, resetToken, time.Now().Add(1*time.Hour),
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 發送密碼重設郵件
	if err := email.SendPasswordReset(user.Email, resetToken); err != nil {
		log.Printf("密碼重設郵件發送失敗: %v", err)
	}

	return successResponse
}

// ResetPassword 使用 token 重設密碼
func (h *Handler) ResetPassword(c *fiber.Ctx) error {
	var req ResetPasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.Token == "" || req.NewPassword == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "Token 和新密碼為必填",
		})
	}

	if len(req.NewPassword) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "密碼至少 8 個字元",
		})
	}

	// 驗證 token
	var tokenRecord struct {
		ID        uuid.UUID `db:"id"`
		UserID    uuid.UUID `db:"user_id"`
		Token     string    `db:"token"`
		ExpiresAt time.Time `db:"expires_at"`
		Used      bool      `db:"used"`
	}
	err := h.db.Get(&tokenRecord,
		`SELECT id, user_id, token, expires_at, used
		 FROM password_reset_tokens
		 WHERE token = $1`,
		req.Token,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"data":  nil,
				"error": "無效的重設 Token",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 檢查 token 是否已使用
	if tokenRecord.Used {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "此 Token 已被使用",
		})
	}

	// 檢查 token 是否已過期
	if time.Now().After(tokenRecord.ExpiresAt) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "此 Token 已過期",
		})
	}

	// Hash 新密碼
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 更新密碼
	_, err = h.db.Exec(
		`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
		string(hashedPassword), tokenRecord.UserID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "密碼更新失敗",
		})
	}

	// 標記 token 為已使用
	h.db.Exec(
		`UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
		tokenRecord.ID,
	)

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "密碼已成功重設",
		},
		"error": nil,
	})
}

// ChangePassword 已登入用戶變更密碼
func (h *Handler) ChangePassword(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "未授權",
		})
	}

	var req ChangePasswordRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "請求格式錯誤",
		})
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "目前密碼和新密碼為必填",
		})
	}

	if len(req.NewPassword) < 8 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"data":  nil,
			"error": "密碼至少 8 個字元",
		})
	}

	// 查詢用戶
	var user User
	err := h.db.Get(&user,
		`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "用戶不存在",
		})
	}

	// 驗證目前密碼
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)); err != nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "目前密碼錯誤",
		})
	}

	// Hash 新密碼
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "伺服器錯誤",
		})
	}

	// 更新密碼
	_, err = h.db.Exec(
		`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
		string(hashedPassword), userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "密碼更新失敗",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "密碼已成功變更",
		},
		"error": nil,
	})
}

// DeleteAccount 軟刪除用戶帳號
func (h *Handler) DeleteAccount(c *fiber.Ctx) error {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"data":  nil,
			"error": "未授權",
		})
	}

	// 軟刪除（設定 deleted_at）
	result, err := h.db.Exec(
		`UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
			"data":  nil,
			"error": "帳號刪除失敗",
		})
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"data":  nil,
			"error": "用戶不存在",
		})
	}

	return c.JSON(fiber.Map{
		"data": fiber.Map{
			"message": "帳號已成功刪除",
		},
		"error": nil,
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
		"exp": time.Now().Add(24 * time.Hour).Unix(),
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
