package handlers

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
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
			personality.SystemPrompt = "你是 AI 會議助手，替用戶參加視訊會議。規則：1)回答控制在100字以內，像真人對話一樣簡短自然 2)絕對不要說「再見」「下次見」「期待下次」等告別語 3)聽不懂就請對方再說一次 4)忽略亂碼和語音辨識雜訊 5)使用繁體中文"
			personality.LLMModel = "claude-sonnet-4-6"
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

		// 共用 HTTP client（連線池，避免每次建立新連線）
		httpClient := &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        10,
				IdleConnTimeout:     90 * time.Second,
				MaxConnsPerHost:     5,
				MaxIdleConnsPerHost: 5,
			},
		}

		// 用 channel 做訊息排程，新訊息取消舊的處理
		msgChan := make(chan TranscriptionMessage, 10)

		// 背景 goroutine 處理訊息（只處理最新的，跳過積壓的舊訊息）
		go func() {
			for msg := range msgChan {
				// 把 channel 裡積壓的舊訊息全部丟掉，只處理最新的
				latest := msg
				drained := 0
				for {
					select {
					case newer := <-msgChan:
						latest = newer
						drained++
					default:
						goto process
					}
				}
			process:
				if drained > 0 {
					log.Printf("跳過 %d 筆舊訊息，處理最新: %s", drained, latest.Text)
				}

				voiceGender := latest.VoiceGender
				if voiceGender == "" {
					voiceGender = "female"
				}
				useCustomVoice := voiceID != "" && voiceID != "default"

				writeWSMessage(conn, WSMessage{
					Type: "thinking_animation",
					Data: fiber.Map{"status": "start"},
				})

				h.processStreamingPipeline(
					conn, httpClient, latest, sessionID, userID,
					personality.SystemPrompt, personality.LLMModel, personality.Temperature, personality.Language,
					voiceGender, voiceID, useCustomVoice, faceImageURL, sessionFaceBase64,
				)

				h.db.Exec(
					`UPDATE meeting_sessions SET total_responses = total_responses + 1
					 WHERE id = $1`,
					sessionID,
				)
			}
		}()

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

			log.Printf("收到訊息: %s", msg.Text)

			// 送到處理 channel（非阻塞，積壓的會被跳過）
			select {
			case msgChan <- msg:
			default:
				// channel 滿了，丟掉最舊的再放新的
				select {
				case <-msgChan:
				default:
				}
				msgChan <- msg
			}
		}
		close(msgChan)
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

// callFastTTS 呼叫 Edge TTS 快速語音合成（<1 秒，無需 GPU）
func callFastTTS(text, voiceGender string) (string, error) {
	gpuServiceURL := os.Getenv("GPU_SERVICE_URL")
	if gpuServiceURL == "" {
		gpuServiceURL = "http://localhost:8002"
	}

	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_gender": voiceGender,
	})

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(
		gpuServiceURL+"/api/v1/tts/fast-synthesize",
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("Edge TTS 錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return "", fmt.Errorf("解析 Edge TTS 回應失敗: %w", err)
	}

	return gpuServiceURL + gpuResp.Data.AudioURL, nil
}

// callWav2LipFromAudio 用既有音訊 + 臉部圖片產生 Wav2Lip 臉部動畫
func callWav2LipFromAudio(audioURL, faceImageURL, faceImageBase64 string) (string, error) {
	gpuServiceURL := os.Getenv("GPU_SERVICE_URL")
	if gpuServiceURL == "" {
		gpuServiceURL = "http://localhost:8002"
	}

	// 從完整 URL 中取出相對路徑（/outputs/xxx.wav）
	relativeAudioURL := audioURL
	if strings.HasPrefix(audioURL, gpuServiceURL) {
		relativeAudioURL = audioURL[len(gpuServiceURL):]
	}

	payload := map[string]string{
		"audio_url":      relativeAudioURL,
		"face_image_url": faceImageURL,
	}
	if faceImageBase64 != "" {
		payload["face_image_base64"] = faceImageBase64
	}
	reqBody, _ := json.Marshal(payload)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Post(
		gpuServiceURL+"/api/v1/avatar/animate-from-audio",
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("Wav2Lip 錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return "", fmt.Errorf("解析 Wav2Lip 回應失敗: %w", err)
	}

	if gpuResp.Data.VideoURL != "" {
		return gpuServiceURL + gpuResp.Data.VideoURL, nil
	}
	return "", nil
}

// ttsResult 句子級 TTS 結果
type ttsResult struct {
	audioURL string
	err      error
	index    int
}

// processStreamingPipeline 串流 LLM + 句子級並行 TTS Pipeline
// 核心優化：LLM 邊生成邊觸發 TTS，第一句話到達就開始合成語音
func (h *WebSocketHandler) processStreamingPipeline(
	conn *websocket.Conn,
	httpClient *http.Client,
	msg TranscriptionMessage,
	sessionID, userID string,
	systemPrompt, llmModel string, temperature float64, language string,
	voiceGender, voiceID string,
	useCustomVoice bool,
	faceImageURL, sessionFaceBase64 string,
) {
	aiServiceURL := os.Getenv("AI_SERVICE_URL")
	if aiServiceURL == "" {
		aiServiceURL = "http://localhost:8001"
	}
	gpuServiceURL := os.Getenv("GPU_SERVICE_URL")
	if gpuServiceURL == "" {
		gpuServiceURL = "http://localhost:8002"
	}

	// 嘗試串流，失敗則回退到非串流
	reqBody, _ := json.Marshal(AIServiceRequest{
		Text:         msg.Text,
		SessionID:    sessionID,
		UserID:       userID,
		SystemPrompt: systemPrompt,
		LLMModel:     llmModel,
		Temperature:  temperature,
		Language:     language,
	})

	streamReq, _ := http.NewRequest("POST", aiServiceURL+"/api/v1/generate/stream", bytes.NewBuffer(reqBody))
	streamReq.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(streamReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		// 回退到非串流模式
		if resp != nil {
			resp.Body.Close()
		}
		log.Printf("串流 LLM 失敗，回退非串流: %v", err)
		h.processNonStreaming(conn, httpClient, msg, sessionID, userID,
			systemPrompt, llmModel, temperature, language,
			voiceGender, voiceID, useCustomVoice, faceImageURL, sessionFaceBase64)
		return
	}
	defer resp.Body.Close()

	// 讀取 SSE 串流，逐句處理
	var sentences []string
	var fullText strings.Builder
	var ttsResultChans []chan ttsResult
	var mu sync.Mutex

	startTime := time.Now()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := line[6:]
		if data == "[DONE]" {
			break
		}

		var event struct {
			Text string `json:"text"`
		}
		if json.Unmarshal([]byte(data), &event) != nil || event.Text == "" {
			continue
		}

		sentence := event.Text
		sentenceIdx := len(sentences)
		sentences = append(sentences, sentence)
		fullText.WriteString(sentence)

		// 逐句推送文字給客戶端（用戶看到文字逐句出現）
		writeWSMessage(conn, WSMessage{
			Type: "suggestion_text",
			Data: fiber.Map{
				"text":       fullText.String(),
				"session_id": sessionID,
			},
		})

		// Mode 2/3: 每個句子立刻啟動 TTS（與 LLM 生成並行）
		if msg.Mode >= 2 {
			ch := make(chan ttsResult, 1)
			mu.Lock()
			ttsResultChans = append(ttsResultChans, ch)
			mu.Unlock()

			go func(s string, idx int, resCh chan<- ttsResult) {
				var url string
				var ttsErr error
				if useCustomVoice {
					url, ttsErr = callGPUTTS(s, voiceID, voiceGender)
				} else {
					url, ttsErr = callFastTTS(s, voiceGender)
				}
				resCh <- ttsResult{audioURL: url, err: ttsErr, index: idx}
			}(sentence, sentenceIdx, ch)
		}
	}

	llmElapsed := time.Since(startTime)

	// 停止思考動畫
	writeWSMessage(conn, WSMessage{
		Type: "thinking_animation",
		Data: fiber.Map{"status": "stop"},
	})

	// 發送完整文字
	finalText := fullText.String()
	if finalText == "" {
		writeWSMessage(conn, WSMessage{Type: "error", Data: "AI 無回覆"})
		return
	}

	writeWSMessage(conn, WSMessage{
		Type: "suggestion_text",
		Data: fiber.Map{
			"text":       finalText,
			"session_id": sessionID,
		},
	})

	log.Printf("串流 LLM 完成: %d 句, %dms", len(sentences), llmElapsed.Milliseconds())

	// Mode 2/3: 收集所有 TTS 結果並合併音訊
	if msg.Mode >= 2 && len(ttsResultChans) > 0 {
		writeWSMessage(conn, WSMessage{
			Type: "tts_status",
			Data: fiber.Map{"status": "generating"},
		})

		// 收集所有句子的音訊 URL（按順序）
		audioURLs := make([]string, len(ttsResultChans))
		for i, ch := range ttsResultChans {
			result := <-ch
			if result.err != nil {
				log.Printf("TTS 第 %d 句失敗: %v", i, result.err)
				continue
			}
			audioURLs[i] = result.audioURL
		}

		// 過濾空值
		var validAudioURLs []string
		for _, url := range audioURLs {
			if url != "" {
				validAudioURLs = append(validAudioURLs, url)
			}
		}

		if len(validAudioURLs) == 0 {
			writeWSMessage(conn, WSMessage{
				Type: "tts_status",
				Data: fiber.Map{"status": "error", "error": "所有句子 TTS 失敗"},
			})
			return
		}

		// 如果只有一段音訊，直接送出
		var finalAudioURL string
		if len(validAudioURLs) == 1 {
			finalAudioURL = validAudioURLs[0]
		} else {
			// 多段音訊：呼叫合併端點
			relativeURLs := make([]string, len(validAudioURLs))
			for i, url := range validAudioURLs {
				if strings.HasPrefix(url, gpuServiceURL) {
					relativeURLs[i] = url[len(gpuServiceURL):]
				} else {
					relativeURLs[i] = url
				}
			}

			concatURL, concatErr := callConcatenateAudio(httpClient, gpuServiceURL, relativeURLs)
			if concatErr != nil {
				log.Printf("音訊合併失敗: %v，使用第一段", concatErr)
				finalAudioURL = validAudioURLs[0]
			} else {
				finalAudioURL = concatURL
			}
		}

		if finalAudioURL != "" {
			writeWSMessage(conn, WSMessage{
				Type: "tts_audio",
				Data: fiber.Map{
					"audio_url":  finalAudioURL,
					"session_id": sessionID,
				},
			})

			// Mode 3: Wav2Lip 背景執行
			if msg.Mode == 3 {
				go func(aURL, fURL, fBase64, sid string) {
					vURL, wErr := callWav2LipFromAudio(aURL, fURL, fBase64)
					if wErr != nil {
						log.Printf("Wav2Lip 背景失敗: %v", wErr)
						return
					}
					if vURL != "" {
						writeWSMessage(conn, WSMessage{
							Type: "avatar_video",
							Data: fiber.Map{
								"video_url":  vURL,
								"session_id": sid,
							},
						})
					}
				}(finalAudioURL, faceImageURL, sessionFaceBase64, sessionID)
			}
		}
	}

	log.Printf("Pipeline 完成: LLM=%dms, 句子=%d", llmElapsed.Milliseconds(), len(sentences))
}

// processNonStreaming 非串流模式（回退用）
func (h *WebSocketHandler) processNonStreaming(
	conn *websocket.Conn,
	httpClient *http.Client,
	msg TranscriptionMessage,
	sessionID, userID string,
	systemPrompt, llmModel string, temperature float64, language string,
	voiceGender, voiceID string,
	useCustomVoice bool,
	faceImageURL, sessionFaceBase64 string,
) {
	aiResponse, err := callAIService(AIServiceRequest{
		Text:         msg.Text,
		SessionID:    sessionID,
		UserID:       userID,
		SystemPrompt: systemPrompt,
		LLMModel:     llmModel,
		Temperature:  temperature,
		Language:     language,
	})

	writeWSMessage(conn, WSMessage{
		Type: "thinking_animation",
		Data: fiber.Map{"status": "stop"},
	})

	if err != nil {
		log.Printf("AI 服務呼叫失敗: %v", err)
		writeWSMessage(conn, WSMessage{Type: "error", Data: "AI 服務暫時無法使用"})
		return
	}

	writeWSMessage(conn, WSMessage{
		Type: "suggestion_text",
		Data: fiber.Map{"text": aiResponse.Text, "session_id": sessionID},
	})

	if msg.Mode >= 2 {
		writeWSMessage(conn, WSMessage{
			Type: "tts_status",
			Data: fiber.Map{"status": "generating"},
		})

		var audioURL string
		var ttsErr error

		if useCustomVoice {
			if msg.Mode == 3 {
				var videoURL string
				audioURL, videoURL, ttsErr = callGPUAvatar(aiResponse.Text, voiceID, voiceGender, faceImageURL, sessionFaceBase64)
				if ttsErr == nil && videoURL != "" {
					writeWSMessage(conn, WSMessage{
						Type: "avatar_video",
						Data: fiber.Map{"video_url": videoURL, "session_id": sessionID},
					})
				}
			} else {
				audioURL, ttsErr = callGPUTTS(aiResponse.Text, voiceID, voiceGender)
			}
		} else {
			audioURL, ttsErr = callFastTTS(aiResponse.Text, voiceGender)
			if ttsErr == nil && audioURL != "" && msg.Mode == 3 {
				go func(aURL, fURL, fBase64, sid string) {
					vURL, wErr := callWav2LipFromAudio(aURL, fURL, fBase64)
					if wErr != nil {
						log.Printf("Wav2Lip 背景失敗: %v", wErr)
						return
					}
					if vURL != "" {
						writeWSMessage(conn, WSMessage{
							Type: "avatar_video",
							Data: fiber.Map{"video_url": vURL, "session_id": sid},
						})
					}
				}(audioURL, faceImageURL, sessionFaceBase64, sessionID)
			}
		}

		if ttsErr != nil {
			log.Printf("TTS 失敗: %v", ttsErr)
			writeWSMessage(conn, WSMessage{
				Type: "tts_status",
				Data: fiber.Map{"status": "error", "error": ttsErr.Error()},
			})
		} else if audioURL != "" {
			writeWSMessage(conn, WSMessage{
				Type: "tts_audio",
				Data: fiber.Map{"audio_url": audioURL, "session_id": sessionID},
			})
		}
	}
}

// callConcatenateAudio 呼叫 GPU 服務合併多段音訊
func callConcatenateAudio(httpClient *http.Client, gpuServiceURL string, audioURLs []string) (string, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"audio_urls": audioURLs,
	})

	resp, err := httpClient.Post(
		gpuServiceURL+"/api/v1/tts/concatenate",
		"application/json",
		bytes.NewBuffer(reqBody),
	)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("音訊合併錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return "", fmt.Errorf("解析合併回應失敗: %w", err)
	}

	return gpuServiceURL + gpuResp.Data.AudioURL, nil
}

// callAIService 呼叫 Python LLM 服務（非串流，回退用）
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
