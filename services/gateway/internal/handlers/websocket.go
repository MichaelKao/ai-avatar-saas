package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jmoiron/sqlx"
)

// WebSocketHandler WebSocket 即時通訊處理器
type WebSocketHandler struct {
	db *sqlx.DB
}

// WSMessage WebSocket 訊息結構
type WSMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// TranscriptionMessage 語音辨識文字訊息
type TranscriptionMessage struct {
	Text             string `json:"text"`
	SessionID        string `json:"session_id"`
	Language         string `json:"language"`
	Mode             int    `json:"mode"` // 1=Prompt, 2=Avatar, 3=Full
	VoiceGender      string `json:"voice_gender,omitempty"`       // "male" 或 "female"
	FaceImageBase64  string `json:"face_image_base64,omitempty"`  // 即時 webcam 截圖
}

// AIServiceRequest 呼叫 AI 服務的請求
type AIServiceRequest struct {
	Text         string  `json:"text"`
	SessionID    string  `json:"session_id"`
	UserID       string  `json:"user_id"`
	SystemPrompt string  `json:"system_prompt"`
	LLMModel     string  `json:"llm_model"`
	Temperature  float64 `json:"temperature"`
	Language     string  `json:"language"`
}

// AIServiceResponse AI 服務回應
type AIServiceResponse struct {
	Text      string `json:"text"`
	SessionID string `json:"session_id"`
}

// NewWebSocketHandler 建立 WebSocketHandler 實例
func NewWebSocketHandler(db *sqlx.DB) *WebSocketHandler {
	return &WebSocketHandler{db: db}
}

// Upgrade WebSocket 升級中間件（含 JWT 驗證）
func (h *WebSocketHandler) Upgrade() fiber.Handler {
	return func(c *fiber.Ctx) error {
		// 檢查是否為 WebSocket 升級請求
		if !websocket.IsWebSocketUpgrade(c) {
			return c.Status(fiber.StatusUpgradeRequired).JSON(fiber.Map{
				"data":  nil,
				"error": "需要 WebSocket 連線",
			})
		}

		// 從 query parameter 或 header 取得 JWT token
		token := c.Query("token")
		if token == "" {
			authHeader := c.Get("Authorization")
			if authHeader != "" {
				parts := strings.SplitN(authHeader, " ", 2)
				if len(parts) == 2 && parts[0] == "Bearer" {
					token = parts[1]
				}
			}
		}

		if token == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"data":  nil,
				"error": "缺少認證 Token",
			})
		}

		// 驗證 JWT
		secret := os.Getenv("JWT_SECRET")
		if secret == "" {
			secret = "dev-secret-key-at-least-32-characters-long"
		}

		parsedToken, err := jwt.Parse(token, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fiber.NewError(fiber.StatusUnauthorized, "無效的簽名方法")
			}
			return []byte(secret), nil
		})

		if err != nil || !parsedToken.Valid {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"data":  nil,
				"error": "Token 無效或已過期",
			})
		}

		claims, ok := parsedToken.Claims.(jwt.MapClaims)
		if !ok {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"data":  nil,
				"error": "Token 格式錯誤",
			})
		}

		// 將 userID 存入 Locals
		c.Locals("userID", claims["sub"])

		return c.Next()
	}
}

// HandleSession WebSocket 會議 Session 處理
func (h *WebSocketHandler) HandleSession() fiber.Handler {
	return websocket.New(func(conn *websocket.Conn) {
		userID, _ := conn.Locals("userID").(string)
		sessionID := conn.Params("sessionId")

		log.Printf("WebSocket 連線建立: userID=%s, sessionID=%s", userID, sessionID)
		defer func() {
			log.Printf("WebSocket 連線關閉: userID=%s, sessionID=%s", userID, sessionID)
			conn.Close()
		}()

		// 驗證 Session 屬於該用戶且進行中
		var exists bool
		err := h.db.Get(&exists,
			`SELECT EXISTS(
				SELECT 1 FROM meeting_sessions
				WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
			)`,
			sessionID, userID,
		)

		if err != nil || !exists {
			writeWSMessage(conn, WSMessage{
				Type: "error",
				Data: "Session 不存在或已結束",
			})
			return
		}

		// 取得用戶的預設個性設定
		var personality struct {
			SystemPrompt string  `db:"system_prompt"`
			LLMModel     string  `db:"llm_model"`
			Temperature  float64 `db:"temperature"`
			Language     string  `db:"language"`
		}

		err = h.db.Get(&personality,
			`SELECT system_prompt, llm_model, temperature, language
			 FROM ai_personalities
			 WHERE user_id = $1 AND is_default = TRUE AND deleted_at IS NULL
			 LIMIT 1`,
			userID,
		)

		if err != nil {
			// 使用預設值
			personality.SystemPrompt = "你是一位專業的 AI 會議助手，請用繁體中文回答。"
			personality.LLMModel = "claude-sonnet-4-20250514"
			personality.Temperature = 0.7
			personality.Language = "zh-TW"
		}

		// 取得用戶的 voice_id 和 face_image_url（Mode 2/3 用）
		var voiceID string
		var faceImageURL string
		h.db.Get(&voiceID,
			`SELECT COALESCE(voice_model_id, '') FROM avatar_profiles WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
			userID,
		)
		h.db.Get(&faceImageURL,
			`SELECT COALESCE(face_image_url, '') FROM avatar_profiles WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`,
			userID,
		)

		// 如果沒有設定，使用預設值
		if voiceID == "" {
			voiceID = "default"
		}
		if faceImageURL == "" {
			faceImageURL = "default"
		}

		// 發送連線成功訊息
		writeWSMessage(conn, WSMessage{
			Type: "connected",
			Data: fiber.Map{
				"session_id": sessionID,
				"user_id":    userID,
				"llm_model":  personality.LLMModel,
				"voice_id":   voiceID,
			},
		})

		// 每個連線記住 face_image_base64（只需傳送一次）
		var sessionFaceBase64 string

		// 持續接收訊息
		for {
			var msg TranscriptionMessage
			if err := conn.ReadJSON(&msg); err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
					log.Printf("WebSocket 讀取錯誤: %v", err)
				}
				break
			}

			// 設定 SessionID
			if msg.SessionID == "" {
				msg.SessionID = sessionID
			}

			// 儲存 face_image_base64（第一次傳送後記住，後續訊息不需再傳）
			if msg.FaceImageBase64 != "" {
				sessionFaceBase64 = msg.FaceImageBase64
			}

			// 忽略空訊息
			if msg.Text == "" {
				continue
			}

			// 發送思考動畫訊息
			writeWSMessage(conn, WSMessage{
				Type: "thinking_animation",
				Data: fiber.Map{
					"status": "start",
				},
			})

			// 呼叫 AI 服務取得回應
			aiResponse, err := callAIService(AIServiceRequest{
				Text:         msg.Text,
				SessionID:    sessionID,
				UserID:       userID,
				SystemPrompt: personality.SystemPrompt,
				LLMModel:     personality.LLMModel,
				Temperature:  personality.Temperature,
				Language:     personality.Language,
			})

			// 停止思考動畫
			writeWSMessage(conn, WSMessage{
				Type: "thinking_animation",
				Data: fiber.Map{
					"status": "stop",
				},
			})

			if err != nil {
				log.Printf("AI 服務呼叫失敗: %v", err)
				writeWSMessage(conn, WSMessage{
					Type: "error",
					Data: "AI 服務暫時無法使用",
				})
				continue
			}

			// 發送 AI 建議文字（所有模式都有）
			writeWSMessage(conn, WSMessage{
				Type: "suggestion_text",
				Data: fiber.Map{
					"text":       aiResponse.Text,
					"session_id": sessionID,
				},
			})

			// 決定聲音性別（優先用訊息帶的，否則預設 female）
			voiceGender := msg.VoiceGender
			if voiceGender == "" {
				voiceGender = "female"
			}

			// Mode 2: TTS 語音合成
			if msg.Mode == 2 && voiceID != "" {
				writeWSMessage(conn, WSMessage{
					Type: "tts_status",
					Data: fiber.Map{"status": "generating"},
				})

				audioURL, err := callGPUTTS(aiResponse.Text, voiceID, voiceGender)
				if err != nil {
					log.Printf("TTS 失敗: %v", err)
					writeWSMessage(conn, WSMessage{
						Type: "tts_status",
						Data: fiber.Map{"status": "error", "error": err.Error()},
					})
				} else {
					writeWSMessage(conn, WSMessage{
						Type: "tts_audio",
						Data: fiber.Map{
							"audio_url":  audioURL,
							"session_id": sessionID,
						},
					})
				}
			}

			// Mode 3: TTS + 臉部動畫（Wav2Lip）
			if msg.Mode == 3 {
				writeWSMessage(conn, WSMessage{
					Type: "tts_status",
					Data: fiber.Map{"status": "generating"},
				})

				audioURL, videoURL, err := callGPUAvatar(aiResponse.Text, voiceID, voiceGender, faceImageURL, sessionFaceBase64)
				if err != nil {
					log.Printf("Mode 3 Avatar 失敗: %v", err)
					writeWSMessage(conn, WSMessage{
						Type: "tts_status",
						Data: fiber.Map{"status": "error", "error": err.Error()},
					})
				} else {
					// 發送 TTS 音訊
					writeWSMessage(conn, WSMessage{
						Type: "tts_audio",
						Data: fiber.Map{
							"audio_url":  audioURL,
							"session_id": sessionID,
						},
					})
					// 發送 Avatar 影片（如果有生成）
					if videoURL != "" {
						writeWSMessage(conn, WSMessage{
							Type: "avatar_video",
							Data: fiber.Map{
								"video_url":  videoURL,
								"session_id": sessionID,
							},
						})
					}
				}
			}

			// 更新回應計數
			h.db.Exec(
				`UPDATE meeting_sessions SET total_responses = total_responses + 1
				 WHERE id = $1`,
				sessionID,
			)
		}
	})
}

// writeWSMessage 將訊息寫入 WebSocket 連線
func writeWSMessage(conn *websocket.Conn, msg WSMessage) {
	if err := conn.WriteJSON(msg); err != nil {
		log.Printf("WebSocket 寫入錯誤: %v", err)
	}
}

// GPUResponse GPU 服務通用回應
type GPUResponse struct {
	Data struct {
		AudioURL string `json:"audio_url"`
		VideoURL string `json:"video_url"`
	} `json:"data"`
}

// callGPUTTS 呼叫 GPU 服務做語音合成（Mode 2）
func callGPUTTS(text, voiceID, voiceGender string) (string, error) {
	gpuServiceURL := os.Getenv("GPU_SERVICE_URL")
	if gpuServiceURL == "" {
		gpuServiceURL = "http://localhost:8002"
	}

	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_id":     voiceID,
		"voice_gender": voiceGender,
	})

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Post(
		gpuServiceURL+"/api/v1/tts/synthesize",
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("GPU TTS 錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return "", fmt.Errorf("解析 GPU 回應失敗: %w", err)
	}

	// 回傳完整 URL
	return gpuServiceURL + gpuResp.Data.AudioURL, nil
}

// callGPUAvatar 呼叫 GPU 服務做 TTS + 臉部動畫（Mode 3）
func callGPUAvatar(text, voiceID, voiceGender, faceImageURL, faceImageBase64 string) (audioURL string, videoURL string, err error) {
	gpuServiceURL := os.Getenv("GPU_SERVICE_URL")
	if gpuServiceURL == "" {
		gpuServiceURL = "http://localhost:8002"
	}

	payload := map[string]string{
		"text":           text,
		"voice_id":       voiceID,
		"voice_gender":   voiceGender,
		"face_image_url": faceImageURL,
	}
	if faceImageBase64 != "" {
		payload["face_image_base64"] = faceImageBase64
	}
	reqBody, _ := json.Marshal(payload)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Post(
		gpuServiceURL+"/api/v1/avatar/generate-talking",
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("GPU Avatar 錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return "", "", fmt.Errorf("解析 GPU 回應失敗: %w", err)
	}

	audioURL = gpuServiceURL + gpuResp.Data.AudioURL
	if gpuResp.Data.VideoURL != "" {
		videoURL = gpuServiceURL + gpuResp.Data.VideoURL
	}
	return audioURL, videoURL, nil
}

// callAIService 呼叫 Python LLM 服務
func callAIService(req AIServiceRequest) (*AIServiceResponse, error) {
	aiServiceURL := os.Getenv("AI_SERVICE_URL")
	if aiServiceURL == "" {
		aiServiceURL = "http://localhost:8001"
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(
		aiServiceURL+"/api/v1/generate",
		"application/json",
		bytes.NewBuffer(body),
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var aiResp AIServiceResponse
	if err := json.Unmarshal(respBody, &aiResp); err != nil {
		return nil, err
	}

	return &aiResp, nil
}
