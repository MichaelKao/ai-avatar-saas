package email

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
)

// ResendRequest Resend API 請求
type ResendRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

// Send 使用 Resend API 發送郵件
func Send(to, subject, html string) error {
	apiKey := os.Getenv("RESEND_API_KEY")
	if apiKey == "" {
		log.Printf("RESEND_API_KEY 未設定，跳過寄信: to=%s, subject=%s", to, subject)
		return nil
	}

	from := os.Getenv("MAIL_FROM")
	if from == "" {
		from = "noreply@vibeaico.com"
	}

	reqBody := ResendRequest{
		From:    from,
		To:      []string{to},
		Subject: subject,
		HTML:    html,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("JSON 編碼失敗: %w", err)
	}

	req, err := http.NewRequest("POST", "https://api.resend.com/emails", bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("建立請求失敗: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("發送請求失敗: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Resend API 錯誤 (%d): %s", resp.StatusCode, string(respBody))
	}

	log.Printf("郵件已發送: to=%s, subject=%s", to, subject)
	return nil
}

// SendPasswordReset 發送密碼重設郵件
func SendPasswordReset(toEmail, resetToken string) error {
	frontendURL := os.Getenv("FRONTEND_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:3000"
	}

	resetLink := fmt.Sprintf("%s/reset-password?token=%s", frontendURL, resetToken)

	html := fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #2563eb;">AI Avatar SaaS — 密碼重設</h2>
  <p>您好，</p>
  <p>我們收到了您的密碼重設請求。請點擊下方按鈕重設密碼：</p>
  <p style="margin: 30px 0;">
    <a href="%s" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
      重設密碼
    </a>
  </p>
  <p style="color: #6b7280; font-size: 14px;">此連結將在 1 小時後過期。</p>
  <p style="color: #6b7280; font-size: 14px;">如果您沒有申請密碼重設，請忽略此郵件。</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
  <p style="color: #9ca3af; font-size: 12px;">AI Avatar SaaS — 智能數位分身會議助理</p>
</body>
</html>`, resetLink)

	return Send(toEmail, "重設您的密碼 — AI Avatar SaaS", html)
}
