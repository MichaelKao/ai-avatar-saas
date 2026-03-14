package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
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
	Text            string `json:"text"`
	SessionID       string `json:"session_id"`
	Language        string `json:"language"`
	Mode            int    `json:"mode"` // 1=Prompt, 2=Avatar, 3=Full
	VoiceGender     string `json:"voice_gender,omitempty"`      // "male" 或 "female"
	FaceImageBase64 string `json:"face_image_base64,omitempty"` // 即時 webcam 截圖
	MsgType         string `json:"type,omitempty"`               // "interrupt" 等控制訊息
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

// gpuInternalURL 取得 GPU 服務內部 URL（API 呼叫用）
func gpuInternalURL() string {
	url := os.Getenv("GPU_SERVICE_URL")
	if url == "" {
		return "http://localhost:8889"
	}
	return url
}

// gpuPublicURL 取得 GPU 服務公開 URL（客戶端下載用）
// Gateway 在 RunPod 上時，GPU_SERVICE_URL 是 localhost，客戶端無法訪問
// GPU_PUBLIC_URL 設為 RunPod 外部 URL，讓客戶端能下載音訊/影片
func gpuPublicURL() string {
	url := os.Getenv("GPU_PUBLIC_URL")
	if url != "" {
		return url
	}
	return gpuInternalURL()
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

		// 取得用戶的預設場景設定（優先），回退到 ai_personalities
		var personality struct {
			SystemPrompt string  `db:"system_prompt"`
			LLMModel     string  `db:"llm_model"`
			Temperature  float64 `db:"temperature"`
			Language     string  `db:"language"`
		}

		// 嘗試從 scenes 表取得預設場景
		var scene struct {
			ID                 string  `db:"id"`
			CustomSystemPrompt *string `db:"custom_system_prompt"`
			LLMModel           string  `db:"llm_model"`
			Temperature        float64 `db:"temperature"`
			Language           string  `db:"language"`
			ReplyLanguage      string  `db:"reply_language"`
			ReplyLength        string  `db:"reply_length"`
			Personality        string  `db:"personality"`
			Formality          int     `db:"formality"`
		}
		sceneErr := h.db.Get(&scene,
			`SELECT id, custom_system_prompt, llm_model, temperature, language,
			        reply_language, reply_length, personality, formality
			 FROM scenes
			 WHERE user_id = $1 AND is_default = TRUE AND deleted_at IS NULL
			 LIMIT 1`,
			userID,
		)

		// 記住活躍場景 ID（RAG 檢索用）
		var activeSceneID string

		if sceneErr == nil {
			// 有預設場景，組合 system prompt
			activeSceneID = scene.ID
			personality.LLMModel = scene.LLMModel
			personality.Temperature = scene.Temperature
			personality.Language = scene.Language

			// 基礎 prompt
			basePrompt := "你是 AI 會議助手，替用戶參加視訊會議。"
			if scene.CustomSystemPrompt != nil && *scene.CustomSystemPrompt != "" {
				basePrompt = *scene.CustomSystemPrompt
			}

			// 組合用戶背景
			var profile struct {
				DisplayName      *string `db:"display_name"`
				Title            *string `db:"title"`
				Company          *string `db:"company"`
				ExperienceYears  int     `db:"experience_years"`
				Skills           *string `db:"skills"`
				Experiences      *string `db:"experiences"`
				CustomPhrases    *string `db:"custom_phrases"`
				AdditionalContext *string `db:"additional_context"`
			}
			profileErr := h.db.Get(&profile,
				`SELECT display_name, title, company, experience_years, skills, experiences, custom_phrases, additional_context
				 FROM user_profiles WHERE scene_id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
				scene.ID, userID,
			)

			var profileBlock string
			if profileErr == nil {
				profileBlock = "\n\n【你的身份背景】\n"
				if profile.DisplayName != nil && *profile.DisplayName != "" {
					profileBlock += "姓名：" + *profile.DisplayName + "\n"
				}
				if profile.Title != nil && *profile.Title != "" {
					profileBlock += "職位：" + *profile.Title + "\n"
				}
				if profile.Company != nil && *profile.Company != "" {
					profileBlock += "公司：" + *profile.Company + "\n"
				}
				if profile.ExperienceYears > 0 {
					profileBlock += fmt.Sprintf("年資：%d 年\n", profile.ExperienceYears)
				}
				if profile.Skills != nil && *profile.Skills != "" {
					profileBlock += "技能：" + *profile.Skills + "\n"
				}
				if profile.Experiences != nil && *profile.Experiences != "" {
					profileBlock += "經歷：" + *profile.Experiences + "\n"
				}
				if profile.CustomPhrases != nil && *profile.CustomPhrases != "" {
					profileBlock += "口頭禪/慣用語：" + *profile.CustomPhrases + "\n"
				}
				if profile.AdditionalContext != nil && *profile.AdditionalContext != "" {
					profileBlock += "其他：" + *profile.AdditionalContext + "\n"
				}
			}

			// 組合知識庫（優先使用分塊，回退到完整內容）
			var kbBlock string

			// 先檢查是否有 embedding_chunks
			var chunkCount int
			h.db.Get(&chunkCount,
				`SELECT COUNT(*) FROM embedding_chunks WHERE scene_id = $1 AND user_id = $2`,
				scene.ID, userID,
			)

			if chunkCount > 0 {
				// 有分塊 → 使用分塊作為知識庫上下文
				var chunks []struct {
					ChunkText string `db:"chunk_text"`
					Title     string `db:"title"`
				}
				h.db.Select(&chunks,
					`SELECT ec.chunk_text, kb.title
					 FROM embedding_chunks ec
					 JOIN knowledge_bases kb ON ec.knowledge_base_id = kb.id AND kb.deleted_at IS NULL
					 WHERE ec.scene_id = $1 AND ec.user_id = $2
					 ORDER BY ec.chunk_index
					 LIMIT 10`,
					scene.ID, userID,
				)

				if len(chunks) > 0 {
					kbBlock = "\n\n【參考知識庫】\n"
					for _, chunk := range chunks {
						kbBlock += "## " + chunk.Title + "\n" + chunk.ChunkText + "\n\n"
					}
				}
			} else {
				// 沒有分塊 → 回退到完整知識庫內容
				var kbItems []struct {
					Title   string `db:"title"`
					Content string `db:"content"`
				}
				h.db.Select(&kbItems,
					`SELECT title, content FROM knowledge_bases
					 WHERE scene_id = $1 AND user_id = $2 AND deleted_at IS NULL
					 ORDER BY created_at LIMIT 5`,
					scene.ID, userID,
				)

				if len(kbItems) > 0 {
					kbBlock = "\n\n【參考知識庫】\n"
					for _, item := range kbItems {
						kbBlock += "## " + item.Title + "\n" + item.Content + "\n\n"
					}
				}
			}

			// 回覆風格指引
			lengthGuide := map[string]string{
				"short":  "回答控制在1-2句，簡短有力。",
				"medium": "回答控制在2-3句，簡潔但有內容。",
				"long":   "回答控制在4-5句，可以詳細展開。",
			}
			replyGuide := lengthGuide[scene.ReplyLength]
			if replyGuide == "" {
				replyGuide = lengthGuide["medium"]
			}
			if scene.ReplyLanguage != "" && scene.ReplyLanguage != scene.Language {
				replyGuide += " 使用" + scene.ReplyLanguage + "回覆。"
			}

			personality.SystemPrompt = basePrompt + profileBlock + kbBlock + "\n\n【回覆規則】\n" + replyGuide + " 忽略亂碼和語音辨識雜訊。絕對不要說告別語。"
		} else {
			// 回退到舊的 ai_personalities 表
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
				personality.LLMModel = "claude-haiku-4-5-20251001"
				personality.Temperature = 0.7
				personality.Language = "zh-TW"
			}
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

		// 場景過渡語設定
		var transitionEnabled bool
		var transitionStyle string
		var sceneLanguage string
		if sceneErr == nil {
			transitionEnabled = scene.ID != "" // 從 scene 取
			sceneLanguage = scene.Language
			// 再讀一次完整 scene 以取得 transition 設定
			var fullScene struct {
				TransitionEnabled bool   `db:"transition_enabled"`
				TransitionStyle   string `db:"transition_style"`
			}
			if h.db.Get(&fullScene,
				`SELECT transition_enabled, transition_style FROM scenes WHERE id = $1 AND deleted_at IS NULL`,
				scene.ID,
			) == nil {
				transitionEnabled = fullScene.TransitionEnabled
				transitionStyle = fullScene.TransitionStyle
			}
		}
		if sceneLanguage == "" {
			sceneLanguage = personality.Language
		}
		if transitionStyle == "" {
			transitionStyle = "natural"
		}

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

		// 進行中的 pipeline 可取消（打斷機制）
		var cancelMu sync.Mutex
		var cancelFunc context.CancelFunc

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

				// 建立可取消的 context
				ctx, cancel := context.WithCancel(context.Background())
				cancelMu.Lock()
				cancelFunc = cancel
				cancelMu.Unlock()

				// 過渡語：Mode 2/3 + 啟用 + 看起來是問題句 → 先播過渡語
				if latest.Mode >= 2 && transitionEnabled && looksLikeQuestion(latest.Text) {
					go h.dispatchTransitionPhrase(ctx, conn, sessionID, sceneLanguage, transitionStyle, voiceGender, useCustomVoice)
				}

				h.processStreamingPipeline(
					ctx, conn, httpClient, latest, sessionID, userID, activeSceneID,
					personality.SystemPrompt, personality.LLMModel, personality.Temperature, personality.Language,
					voiceGender, voiceID, useCustomVoice, faceImageURL, sessionFaceBase64,
				)

				// Pipeline 完成，清除 cancel
				cancelMu.Lock()
				cancelFunc = nil
				cancelMu.Unlock()
				cancel()

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

			// 處理打斷訊息
			if msg.MsgType == "interrupt" {
				log.Printf("收到打斷訊息")
				cancelMu.Lock()
				if cancelFunc != nil {
					cancelFunc()
				}
				cancelMu.Unlock()
				writeWSMessage(conn, WSMessage{
					Type: "interrupt_ack",
					Data: fiber.Map{"session_id": sessionID},
				})
				continue
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

			// 取消進行中的 pipeline（新訊息覆蓋舊的）
			cancelMu.Lock()
			if cancelFunc != nil {
				cancelFunc()
			}
			cancelMu.Unlock()

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
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_id":     voiceID,
		"voice_gender": voiceGender,
	})

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Post(
		gpuInternalURL()+"/api/v1/tts/synthesize",
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

	// 回傳公開 URL（客戶端需下載）
	return gpuPublicURL() + gpuResp.Data.AudioURL, nil
}

// callGPUAvatar 呼叫 GPU 服務做 TTS + 臉部動畫（Mode 3）
func callGPUAvatar(text, voiceID, voiceGender, faceImageURL, faceImageBase64 string) (audioURL string, videoURL string, err error) {
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
		gpuInternalURL()+"/api/v1/avatar/generate-talking",
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

	pubURL := gpuPublicURL()
	audioURL = pubURL + gpuResp.Data.AudioURL
	if gpuResp.Data.VideoURL != "" {
		videoURL = pubURL + gpuResp.Data.VideoURL
	}
	return audioURL, videoURL, nil
}

// streamTTSToClient 串流 TTS pipe：GPU 邊生成 PCM → Gateway 邊收邊轉 WAV → 邊推給 client
// 目標：首字節 < 200ms，client 收到第一段就可以開始播放
func streamTTSToClient(ctx context.Context, conn *websocket.Conn, text, voiceGender string, index int, sessionID string) {
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_id":     "default",
		"voice_gender": voiceGender,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", gpuInternalURL()+"/api/v1/tts/stream-synthesize", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("串流 TTS 失敗: %v，回退非串流", err)
		// 回退到非串流
		url, ttsErr := callCosyVoiceTTS(ctx, text, voiceGender)
		if ttsErr == nil && url != "" {
			writeWSMessage(conn, WSMessage{
				Type: "tts_audio_chunk",
				Data: fiber.Map{"audio_url": url, "index": index, "session_id": sessionID},
			})
		}
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("串流 TTS 錯誤 (%d): %s", resp.StatusCode, string(body))
		return
	}

	pubURL := gpuPublicURL()

	// 邊讀 PCM 邊存，每收到足夠的 chunk 就存成 WAV 並推送
	// CosyVoice 輸出 22050Hz 16bit mono PCM
	buf := make([]byte, 8192) // 8KB ≈ 0.18 秒音訊
	var allPCM []byte
	chunkIdx := 0
	firstChunk := true

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			allPCM = append(allPCM, buf[:n]...)

			// 累積到 ~0.5 秒音訊（22050 samples/s × 2 bytes × 0.5s ≈ 22050 bytes）
			// 首次只要 4096 bytes (~0.1 秒) 就立刻送
			threshold := 22050
			if firstChunk {
				threshold = 4096
			}

			if len(allPCM) >= threshold || readErr != nil {
				// 存成 WAV 推送
				filename := fmt.Sprintf("tts_s%d_c%d_%d.wav", index, chunkIdx, time.Now().UnixNano())
				wavPath := "/workspace/outputs/" + filename
				wavData := pcmToWAV(allPCM, 22050, 1, 16)
				if writeErr := os.WriteFile(wavPath, wavData, 0644); writeErr == nil {
					writeWSMessage(conn, WSMessage{
						Type: "tts_audio_chunk",
						Data: fiber.Map{
							"audio_url":  pubURL + "/outputs/" + filename,
							"index":      index,
							"chunk":      chunkIdx,
							"session_id": sessionID,
						},
					})
					if firstChunk {
						log.Printf("TTS 句 %d 首 chunk 已送出（%d bytes）", index, len(allPCM))
						firstChunk = false
					}
					chunkIdx++
				}
				allPCM = nil
			}
		}

		if readErr != nil {
			break
		}
	}

	// 送剩餘的 PCM
	if len(allPCM) > 0 {
		filename := fmt.Sprintf("tts_s%d_c%d_%d.wav", index, chunkIdx, time.Now().UnixNano())
		wavPath := "/workspace/outputs/" + filename
		wavData := pcmToWAV(allPCM, 22050, 1, 16)
		if writeErr := os.WriteFile(wavPath, wavData, 0644); writeErr == nil {
			writeWSMessage(conn, WSMessage{
				Type: "tts_audio_chunk",
				Data: fiber.Map{
					"audio_url":  pubURL + "/outputs/" + filename,
					"index":      index,
					"chunk":      chunkIdx,
					"session_id": sessionID,
				},
			})
		}
	}
}

// callCosyVoiceTTS 呼叫 CosyVoice 串流語音合成（優先），回退到 Edge TTS
// 使用串流端點：GPU 邊生成邊輸出 PCM → Gateway 收完存 WAV → 回傳 URL
func callCosyVoiceTTS(ctx context.Context, text, voiceGender string) (string, error) {
	// 優先用串流端點
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_id":     "default",
		"voice_gender": voiceGender,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", gpuInternalURL()+"/api/v1/tts/stream-synthesize", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("CosyVoice 串流 TTS 失敗，回退非串流: %v", err)
		return callCosyVoiceTTSSync(ctx, text, voiceGender)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("CosyVoice 串流 TTS 錯誤 (%d): %s，回退非串流", resp.StatusCode, string(body))
		return callCosyVoiceTTSSync(ctx, text, voiceGender)
	}

	// 讀取串流 PCM 數據
	pcmData, err := io.ReadAll(resp.Body)
	if err != nil || len(pcmData) == 0 {
		log.Printf("CosyVoice 串流 TTS 讀取失敗: %v", err)
		return callCosyVoiceTTSSync(ctx, text, voiceGender)
	}

	// PCM → WAV 檔案（22050Hz 16bit mono）
	filename := fmt.Sprintf("tts_stream_%d.wav", time.Now().UnixNano())
	wavPath := "/workspace/outputs/" + filename

	// 寫 WAV header + PCM data
	wavData := pcmToWAV(pcmData, 22050, 1, 16)
	if err := os.WriteFile(wavPath, wavData, 0644); err != nil {
		log.Printf("WAV 寫入失敗: %v", err)
		return callCosyVoiceTTSSync(ctx, text, voiceGender)
	}

	return gpuPublicURL() + "/outputs/" + filename, nil
}

// pcmToWAV 把 raw PCM bytes 轉成 WAV 格式
func pcmToWAV(pcm []byte, sampleRate, channels, bitsPerSample int) []byte {
	dataLen := len(pcm)
	headerLen := 44
	buf := make([]byte, headerLen+dataLen)

	// RIFF header
	copy(buf[0:4], []byte("RIFF"))
	binary.LittleEndian.PutUint32(buf[4:8], uint32(headerLen-8+dataLen))
	copy(buf[8:12], []byte("WAVE"))

	// fmt chunk
	copy(buf[12:16], []byte("fmt "))
	binary.LittleEndian.PutUint32(buf[16:20], 16) // chunk size
	binary.LittleEndian.PutUint16(buf[20:22], 1)  // PCM format
	binary.LittleEndian.PutUint16(buf[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(sampleRate))
	blockAlign := channels * bitsPerSample / 8
	binary.LittleEndian.PutUint32(buf[28:32], uint32(sampleRate*blockAlign)) // byte rate
	binary.LittleEndian.PutUint16(buf[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(buf[34:36], uint16(bitsPerSample))

	// data chunk
	copy(buf[36:40], []byte("data"))
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataLen))
	copy(buf[44:], pcm)

	return buf
}

// callCosyVoiceTTSSync 非串流 CosyVoice TTS（回退用）
func callCosyVoiceTTSSync(ctx context.Context, text, voiceGender string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_id":     "default",
		"voice_gender": voiceGender,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", gpuInternalURL()+"/api/v1/tts/synthesize", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("CosyVoice TTS 失敗，回退 Edge TTS: %v", err)
		return callEdgeTTS(ctx, text, voiceGender)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("CosyVoice TTS 錯誤 (%d): %s，回退 Edge TTS", resp.StatusCode, string(body))
		return callEdgeTTS(ctx, text, voiceGender)
	}

	var gpuResp GPUResponse
	if err := json.NewDecoder(resp.Body).Decode(&gpuResp); err != nil {
		return callEdgeTTS(ctx, text, voiceGender)
	}
	return gpuPublicURL() + gpuResp.Data.AudioURL, nil
}

// callEdgeTTS 呼叫 Edge TTS 快速語音合成（回退用）
func callEdgeTTS(ctx context.Context, text, voiceGender string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_gender": voiceGender,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", gpuInternalURL()+"/api/v1/tts/fast-synthesize", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
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

	return gpuPublicURL() + gpuResp.Data.AudioURL, nil
}

// callMeloTTS 呼叫 MeloTTS 記憶體內語音合成，回傳 base64 WAV（零 file I/O）
func callMeloTTS(ctx context.Context, text, voiceGender string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"text":         text,
		"voice_gender": voiceGender,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", gpuInternalURL()+"/api/v1/tts/melo-synthesize", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("MeloTTS 錯誤 (%d): %s", resp.StatusCode, string(body))
	}

	// 讀取 WAV 二進位，編碼為 base64
	wavBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("讀取 MeloTTS 回應失敗: %w", err)
	}

	return base64.StdEncoding.EncodeToString(wavBytes), nil
}

// callWav2LipFromAudio 用既有音訊 + 臉部圖片產生 Wav2Lip 臉部動畫
func callWav2LipFromAudio(audioURL, faceImageURL, faceImageBase64 string) (string, error) {
	internalURL := gpuInternalURL()
	pubURL := gpuPublicURL()

	// 從完整 URL 中取出相對路徑（/outputs/xxx.wav）
	relativeAudioURL := audioURL
	if strings.HasPrefix(audioURL, pubURL) {
		relativeAudioURL = audioURL[len(pubURL):]
	} else if strings.HasPrefix(audioURL, internalURL) {
		relativeAudioURL = audioURL[len(internalURL):]
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
		internalURL+"/api/v1/avatar/animate-from-audio",
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
		return pubURL + gpuResp.Data.VideoURL, nil
	}
	return "", nil
}

// ttsResult 句子級 TTS 結果
type ttsResult struct {
	audioURL string
	err      error
	index    int
}

// retrieveRelevantChunks 根據用戶問題的關鍵字檢索相關知識庫分塊
// 目前使用 LIKE 匹配，未來可升級為向量相似度搜尋
func (h *WebSocketHandler) retrieveRelevantChunks(sceneID, userID, questionText string, limit int) string {
	if sceneID == "" || questionText == "" {
		return ""
	}

	// 提取關鍵字（去除常見停用詞，取有意義的詞）
	// 中文不需分詞，直接用整段文字做 LIKE 匹配
	// 同時也提取 2-4 字的子串作為關鍵字
	stopWords := map[string]bool{
		"的": true, "了": true, "是": true, "在": true, "我": true, "有": true,
		"和": true, "就": true, "不": true, "人": true, "都": true, "一": true,
		"這": true, "中": true, "大": true, "為": true, "上": true, "個": true,
		"到": true, "說": true, "們": true, "吧": true, "嗎": true, "啊": true,
		"呢": true, "那": true, "他": true, "她": true, "你": true, "也": true,
		"the": true, "is": true, "a": true, "an": true, "and": true, "or": true,
		"of": true, "to": true, "in": true, "it": true, "for": true, "on": true,
		"what": true, "how": true, "why": true, "when": true, "where": true, "who": true,
		"can": true, "do": true, "does": true, "this": true, "that": true,
		"什麼": true, "怎麼": true, "為什麼": true, "哪裡": true, "如何": true,
		"請問": true, "可以": true, "能不能": true,
	}

	// 按空白和標點拆分
	words := strings.FieldsFunc(questionText, func(r rune) bool {
		return r == ' ' || r == ',' || r == '，' || r == '。' || r == '？' ||
			r == '！' || r == '、' || r == '\n' || r == '\t' ||
			r == '?' || r == '!' || r == '.' || r == ';' || r == '；'
	})

	var keywords []string
	for _, w := range words {
		w = strings.TrimSpace(w)
		if w == "" || stopWords[w] {
			continue
		}
		if len([]rune(w)) >= 2 {
			keywords = append(keywords, w)
		}
	}

	if len(keywords) == 0 {
		return ""
	}

	// 限制關鍵字數量
	if len(keywords) > 5 {
		keywords = keywords[:5]
	}

	// 建構 LIKE 查詢：任一關鍵字命中即可
	var conditions []string
	var args []interface{}
	argIdx := 3 // $1=sceneID, $2=userID
	for _, kw := range keywords {
		argIdx++
		conditions = append(conditions, fmt.Sprintf("ec.chunk_text ILIKE $%d", argIdx))
		args = append(args, "%"+kw+"%")
	}

	query := fmt.Sprintf(
		`SELECT ec.chunk_text, kb.title
		 FROM embedding_chunks ec
		 JOIN knowledge_bases kb ON ec.knowledge_base_id = kb.id AND kb.deleted_at IS NULL
		 WHERE ec.scene_id = $1 AND ec.user_id = $2 AND (%s)
		 ORDER BY ec.chunk_index
		 LIMIT $3`,
		strings.Join(conditions, " OR "),
	)

	// 組合所有參數
	allArgs := make([]interface{}, 0, len(args)+3)
	allArgs = append(allArgs, sceneID, userID, limit)
	allArgs = append(allArgs, args...)

	var chunks []struct {
		ChunkText string `db:"chunk_text"`
		Title     string `db:"title"`
	}
	err := h.db.Select(&chunks, query, allArgs...)
	if err != nil {
		log.Printf("RAG 分塊檢索失敗: %v", err)
		return ""
	}

	if len(chunks) == 0 {
		return ""
	}

	var ragBlock strings.Builder
	ragBlock.WriteString("\n\n【相關參考資料】\n")
	for _, chunk := range chunks {
		ragBlock.WriteString("## " + chunk.Title + "\n" + chunk.ChunkText + "\n\n")
	}
	return ragBlock.String()
}

// processStreamingPipeline 串流 LLM + 逐句 TTS 即時派發 Pipeline
// 核心優化：LLM 逗號級切段 → 每段立刻 TTS → 立刻送 tts_audio_chunk 給 client
func (h *WebSocketHandler) processStreamingPipeline(
	ctx context.Context,
	conn *websocket.Conn,
	httpClient *http.Client,
	msg TranscriptionMessage,
	sessionID, userID, sceneID string,
	systemPrompt, llmModel string, temperature float64, language string,
	voiceGender, voiceID string,
	useCustomVoice bool,
	faceImageURL, sessionFaceBase64 string,
) {
	aiServiceURL := os.Getenv("AI_SERVICE_URL")
	if aiServiceURL == "" {
		aiServiceURL = "http://localhost:8001"
	}

	// RAG：根據用戶問題檢索相關知識庫分塊，補充到 system prompt
	finalPrompt := systemPrompt
	if sceneID != "" {
		ragContext := h.retrieveRelevantChunks(sceneID, userID, msg.Text, 3)
		if ragContext != "" {
			finalPrompt = systemPrompt + ragContext
			log.Printf("RAG 增強 prompt（+%d 字元）", len(ragContext))
		}
	}

	// 嘗試串流，失敗則回退到非串流
	reqBody, _ := json.Marshal(AIServiceRequest{
		Text:         msg.Text,
		SessionID:    sessionID,
		UserID:       userID,
		SystemPrompt: finalPrompt,
		LLMModel:     llmModel,
		Temperature:  temperature,
		Language:     language,
	})

	streamReq, _ := http.NewRequestWithContext(ctx, "POST", aiServiceURL+"/api/v1/generate/stream", bytes.NewBuffer(reqBody))
	streamReq.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(streamReq)
	if err != nil || resp.StatusCode != http.StatusOK {
		// 回退到非串流模式
		if resp != nil {
			resp.Body.Close()
		}
		log.Printf("串流 LLM 失敗，回退非串流: %v", err)
		h.processNonStreaming(ctx, conn, httpClient, msg, sessionID, userID,
			systemPrompt, llmModel, temperature, language,
			voiceGender, voiceID, useCustomVoice, faceImageURL, sessionFaceBase64)
		return
	}
	defer resp.Body.Close()

	// 讀取 SSE 串流，逐句處理
	var sentences []string
	var fullText strings.Builder
	var ttsWg sync.WaitGroup
	sentenceIndex := 0

	startTime := time.Now()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		// 檢查 context 是否已取消（打斷）
		select {
		case <-ctx.Done():
			log.Printf("Pipeline 被打斷")
			writeWSMessage(conn, WSMessage{
				Type: "thinking_animation",
				Data: fiber.Map{"status": "stop"},
			})
			return
		default:
		}

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
		idx := sentenceIndex
		sentenceIndex++
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

		// Mode 2/3: 每個句子立刻啟動串流 TTS → PCM chunks 即時推送
		if msg.Mode >= 2 {
			ttsWg.Add(1)
			go func(s string, i int) {
				defer ttsWg.Done()

				select {
				case <-ctx.Done():
					return
				default:
				}

				if useCustomVoice {
					// 自訂聲音用 CosyVoice（回傳 URL）
					u, ttsErr := callGPUTTS(s, voiceID, voiceGender)
					if ttsErr != nil || u == "" {
						log.Printf("TTS 第 %d 句失敗: %v", i, ttsErr)
						return
					}
					writeWSMessage(conn, WSMessage{
						Type: "tts_audio_chunk",
						Data: fiber.Map{"audio_url": u, "index": i, "session_id": sessionID},
					})
					// Mode 3: 自訂聲音才觸發 Wav2Lip
					if msg.Mode == 3 {
						go func(aURL, fURL, fBase64, sid string) {
							vURL, wErr := callWav2LipFromAudio(aURL, fURL, fBase64)
							if wErr != nil {
								log.Printf("唇形動畫失敗: %v", wErr)
								return
							}
							if vURL != "" {
								writeWSMessage(conn, WSMessage{
									Type: "avatar_video",
									Data: fiber.Map{"video_url": vURL, "session_id": sid},
								})
							}
						}(u, faceImageURL, sessionFaceBase64, sessionID)
					}
				} else {
					// 預設聲音用 MeloTTS（記憶體內，回傳 base64）
					b64, ttsErr := callMeloTTS(ctx, s, voiceGender)
					if ttsErr != nil || b64 == "" {
						log.Printf("MeloTTS 第 %d 句失敗: %v，回退 CosyVoice", i, ttsErr)
						u, ttsErr := callCosyVoiceTTS(ctx, s, voiceGender)
						if ttsErr != nil || u == "" {
							log.Printf("CosyVoice 也失敗: %v", ttsErr)
							return
						}
						writeWSMessage(conn, WSMessage{
							Type: "tts_audio_chunk",
							Data: fiber.Map{"audio_url": u, "index": i, "session_id": sessionID},
						})
					} else {
						writeWSMessage(conn, WSMessage{
							Type: "tts_audio_chunk",
							Data: fiber.Map{"audio_base64": b64, "index": i, "session_id": sessionID},
						})
					}
				}
			}(sentence, idx)
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

	// 等待所有 TTS goroutine 完成
	if msg.Mode >= 2 {
		ttsWg.Wait()

		// 發送串流結束信號
		writeWSMessage(conn, WSMessage{
			Type: "tts_stream_end",
			Data: fiber.Map{
				"session_id":    sessionID,
				"total_chunks":  len(sentences),
			},
		})
	}

	log.Printf("Pipeline 完成: LLM=%dms, 句子=%d", llmElapsed.Milliseconds(), len(sentences))
}

// processNonStreaming 非串流模式（回退用）
func (h *WebSocketHandler) processNonStreaming(
	ctx context.Context,
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
			// 預設聲音：MeloTTS（記憶體內 base64），失敗回退 CosyVoice
			b64, meloErr := callMeloTTS(ctx, aiResponse.Text, voiceGender)
			if meloErr != nil || b64 == "" {
				log.Printf("MeloTTS 失敗: %v，回退 CosyVoice", meloErr)
				audioURL, ttsErr = callCosyVoiceTTS(ctx, aiResponse.Text, voiceGender)
			} else {
				// MeloTTS 成功，直接送 base64
				writeWSMessage(conn, WSMessage{
					Type: "tts_audio",
					Data: fiber.Map{"audio_base64": b64, "session_id": sessionID},
				})
				// Mode 3 唇形動畫暫不支援 base64，跳過
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
func callConcatenateAudio(httpClient *http.Client, audioURLs []string) (string, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"audio_urls": audioURLs,
	})

	resp, err := httpClient.Post(
		gpuInternalURL()+"/api/v1/tts/concatenate",
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

	return gpuPublicURL() + gpuResp.Data.AudioURL, nil
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

// looksLikeQuestion 判斷文字是否為問題句（值得播放過渡語）
func looksLikeQuestion(text string) bool {
	questionMarkers := []string{
		"？", "?", "嗎", "什麼", "怎麼", "為什麼", "哪", "誰", "幾",
		"how", "what", "why", "where", "when", "who", "which",
		"可以", "能不能", "是不是", "有沒有", "對不對",
	}
	lower := strings.ToLower(text)
	for _, m := range questionMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	// 長句也播放過渡語（對方說了一段話，AI 需要思考時間）
	return len([]rune(text)) > 20
}

// dispatchTransitionPhrase 即時播放過渡語（<200ms，不等 LLM）
func (h *WebSocketHandler) dispatchTransitionPhrase(
	ctx context.Context,
	conn *websocket.Conn,
	sessionID, language, style, voiceGender string,
	useCustomVoice bool,
) {
	select {
	case <-ctx.Done():
		return
	default:
	}

	// 從 DB 隨機取一句過渡語
	var phrase struct {
		Phrase      string  `db:"phrase"`
		AudioBase64 *string `db:"audio_base64"`
	}
	err := h.db.Get(&phrase,
		`SELECT phrase, audio_base64 FROM transition_phrases
		 WHERE language = $1 AND style = $2 AND deleted_at IS NULL
		 ORDER BY RANDOM() LIMIT 1`,
		language, style,
	)
	if err != nil || phrase.Phrase == "" {
		return
	}

	// 如果已有快取音訊 → 直接送
	if phrase.AudioBase64 != nil && *phrase.AudioBase64 != "" {
		writeWSMessage(conn, WSMessage{
			Type: "tts_audio_chunk",
			Data: fiber.Map{
				"audio_base64":  *phrase.AudioBase64,
				"index":         -1, // -1 表示過渡語
				"is_transition": true,
				"session_id":    sessionID,
			},
		})
		log.Printf("過渡語已送出（快取）: %s", phrase.Phrase)
		return
	}

	// 沒有快取 → 即時 TTS 生成
	if useCustomVoice {
		return // 自訂聲音不生成過渡語（風格不一致）
	}

	b64, ttsErr := callMeloTTS(ctx, phrase.Phrase, voiceGender)
	if ttsErr != nil || b64 == "" {
		return
	}

	writeWSMessage(conn, WSMessage{
		Type: "tts_audio_chunk",
		Data: fiber.Map{
			"audio_base64":  b64,
			"index":         -1,
			"is_transition": true,
			"session_id":    sessionID,
		},
	})
	log.Printf("過渡語已送出（即時 TTS）: %s", phrase.Phrase)

	// 背景快取這段音訊，下次直接用
	go func() {
		h.db.Exec(
			`UPDATE transition_phrases SET audio_base64 = $1, is_cached = TRUE
			 WHERE phrase = $2 AND language = $3 AND style = $4 AND deleted_at IS NULL`,
			b64, phrase.Phrase, language, style,
		)
	}()
}
