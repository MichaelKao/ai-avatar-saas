# AI Avatar SaaS

## 線上環境
| 服務 | URL | 說明 |
|------|-----|------|
| Web 前端 | https://ai-avatar-saas-production-f9f9.up.railway.app | Next.js 前台，Railway 部署 |
| API Gateway | https://ai-avatar-saas-production.up.railway.app | Go Fiber，Railway 部署 |
| GPU 服務 | https://oq00jb5vt1laws-8888.proxy.runpod.net | RunPod A40，含 STT/TTS/Avatar/LLM proxy |
| 健康檢查 | https://ai-avatar-saas-production.up.railway.app/health | Gateway |
| GPU 健康檢查 | https://oq00jb5vt1laws-8888.proxy.runpod.net/health | GPU + Whisper + CosyVoice + Wav2Lip |
| 桌面版下載 | https://github.com/MichaelKao/ai-avatar-saas/releases | Tauri 2 桌面安裝檔 |

## 搬網域時需要改的地方
> **重要**：如果更換域名或遷移服務，以下是需要修改的所有位置：

### 1. Railway Gateway 環境變數
在 Railway Dashboard → 你的 Gateway Service → Variables：
| 變數 | 目前值 | 說明 |
|------|--------|------|
| `AI_SERVICE_URL` | `https://oq00jb5vt1laws-8888.proxy.runpod.net` | LLM 代理（透過 RunPod combined 服務） |
| `GPU_SERVICE_URL` | `https://oq00jb5vt1laws-8888.proxy.runpod.net` | TTS + Wav2Lip + STT |
| `CORS_ORIGINS` | `*` 或前端 URL | 如果要限制來源 |
| `DATABASE_URL` | Railway 自動提供 | PostgreSQL |
| `REDIS_URL` | Railway 自動提供 | Redis |

### 2. 桌面 App 預設 URL（需重新 build）
- **檔案**：`apps/desktop/src/App.tsx`
- **行 278**：`apiUrl` 預設值 → Gateway URL
- **行 279**：`gpuUrl` 預設值 → RunPod GPU URL
- 改完後需重新 `npm run tauri build` 並上傳 GitHub Release

### 3. Web 前端
- **檔案**：`apps/web/app/page.tsx`
- **行 44**：桌面版下載連結 → GitHub Release URL

### 4. RunPod GPU 服務
- **Pod ID**：`oq00jb5vt1laws`
- **內部 port**：8889（外部 proxy 8888）
- **LLM 服務**：內部 port 8002（透過 combined.py 代理到 8889）
- 如果換 RunPod Pod，需更新上述所有 URL 中的 pod ID

### 5. 本地 .env 檔
- `services/gateway/.env` — `AI_SERVICE_URL` 和 `GPU_SERVICE_URL`
- `services/ai/.env` — `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`

## 技術棧
Go 1.22 (Fiber) / Python 3.11 (FastAPI) / Next.js 14 / Tauri 2 (Rust)
PostgreSQL 16 / Redis 7 / Stripe / Claude API / OpenAI API
CosyVoice 2.0 (TTS) / Wav2Lip (臉部動畫) / faster-whisper large-v3 (STT)

## 專案結構
- `apps/web/` — Next.js 14 前端（Vercel 部署）
- `apps/desktop/` — Tauri 2 桌面 App（Windows，含 VB-Cable 安裝）
  - `src-tauri/src/main.rs` — Rust 後端（音訊擷取、STT、VB-Cable 播放）
  - `src/App.tsx` — React 前端 UI
- `services/gateway/` — Go API Gateway（Railway 部署）
  - `internal/handlers/websocket.go` — WebSocket 即時通訊（核心流程）
  - `internal/handlers/session.go` — Session 管理
  - `internal/auth/` — JWT 認證
- `services/ai/llm_service/` — Python LLM 服務（RunPod port 8002）
  - `main.py` — FastAPI，`/api/v1/generate` 端點
  - `claude_handler.py` — Anthropic Claude
  - `gpt_handler.py` — OpenAI GPT
- `services/ai/gpu_service/` — Python GPU 服務（RunPod port 8889→8888）
  - `main.py` — FastAPI，TTS + Avatar 端點
  - `combined.py` — 合併 GPU + STT + LLM proxy 的入口
  - `stt_service.py` — Whisper STT
  - `cosyvoice_handler.py` — CosyVoice 2.0 語音克隆
  - `wav2lip_handler.py` — Wav2Lip 臉部動畫
- `packages/shared-types/` — 共用 TypeScript 型別
- `infrastructure/` — Docker + 部署腳本

## 完整資料流（Mode 3 全自動）
```
LINE/Zoom/Teams/Meet 視訊通話
    ↓ 系統音訊
桌面 App (WASAPI Loopback 擷取對方聲音)
    ↓ PCM 16kHz WAV
RunPod Whisper STT (/api/v1/stt/transcribe)
    ↓ 文字
桌面 App → WebSocket → Gateway
    ↓ 文字
Gateway → LLM (/api/v1/generate) → AI 回覆文字
    ↓
Gateway → TTS (/api/v1/tts/synthesize) → 語音 WAV
    ↓
Gateway → Wav2Lip (/api/v1/avatar/generate-talking) → 臉部動畫影片
    ↓ audio_url + video_url
WebSocket → 桌面 App
    ↓
桌面 App → VB-Cable (cpal) → 虛擬麥克風 → 視訊 App 收到 AI 語音
```

## API Keys & Tokens
> **重要**：Repo 已公開，所有 token 和密鑰存放在 Claude memory 或 `.env` 檔案中，不要 commit 到 repo。
> 如需查看 token，參考 Claude 記憶檔或 `.env`。
> 如果 token 過期，到 GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾 `repo` 權限。

## 修改流程
1. 修改程式碼 → 跑對應測試 → 更新 CLAUDE.md → git add + commit + push
2. Railway 自動部署，確認 /health 正常
3. 不要每步確認，修完直接 commit + push

## 關鍵規則
1. 軟刪除：查詢加 `deleted_at IS NULL`
2. API 回應：統一格式 `{ "data": ..., "error": ... }`
3. 註解：繁體中文
4. 環境變數：禁止硬編碼在程式碼中
5. SQL：全用參數化查詢
6. 測試：每個新功能必須附測試
7. 前端：動態內容一律 escapeHtml
8. 時間戳：測試資料用 `Date.now()` 避免衝突

## 測試指令
- Gateway：cd services/gateway && go test ./...
- AI：cd services/ai && pytest -v
- Web：cd apps/web && npx vitest run
- API 整合：npx playwright test tests/api/
- E2E：npx playwright test tests/e2e/
- 全部：make test-all

## 環境變數（.env，不可 commit）

### Gateway（services/gateway/.env）
| 變數 | 說明 | 範例 |
|------|------|------|
| DATABASE_URL | PostgreSQL 連線 | postgres://user:pass@host:5432/db |
| REDIS_URL | Redis 連線 | redis://default:pass@host:6379 |
| JWT_SECRET | JWT 簽名密鑰（至少 32 字元） | your-secret-key-here |
| ANTHROPIC_API_KEY | Claude API Key | sk-ant-api03-... |
| AI_SERVICE_URL | LLM 服務位址 | https://xxx-8888.proxy.runpod.net |
| GPU_SERVICE_URL | GPU 服務位址（TTS/Avatar） | https://xxx-8888.proxy.runpod.net |
| STRIPE_SECRET_KEY | Stripe 付費 | sk_live_... |
| STRIPE_WEBHOOK_SECRET | Stripe Webhook 驗證 | whsec_... |
| PORT | 服務埠號 | 8080 |
| CORS_ORIGINS | 允許的前端來源 | https://your-frontend.com |

### AI 服務（services/ai/.env）
| 變數 | 說明 |
|------|------|
| ANTHROPIC_API_KEY | Claude API Key |
| OPENAI_API_KEY | OpenAI API Key |

## 資料庫
- PostgreSQL 16
- Schema migration 在 services/gateway/internal/database/database.go
- 8 張表：users, avatar_profiles, ai_personalities, meeting_sessions, subscriptions, outfit_presets, background_presets, password_reset_tokens
- 所有表都有 deleted_at 軟刪除欄位
- 查詢必須加 WHERE deleted_at IS NULL

## 三個服務模式
- **模式1** — 提示模式：AI 建議答案顯示在畫面，用戶自己決定採用
- **模式2** — 替身模式：AI 取代聲音（TTS），自動回答
- **模式3** — 全能模式：TTS + 臉部動畫（Wav2Lip），完全自動應答

## RunPod GPU 服務端點
| 端點 | 方法 | 說明 |
|------|------|------|
| `/health` | GET | 健康檢查 |
| `/api/v1/stt/transcribe` | POST | 語音轉文字（Whisper large-v3） |
| `/api/v1/generate` | POST | LLM 文字生成（proxy → port 8002） |
| `/api/v1/tts/synthesize` | POST | 語音合成（CosyVoice 2.0） |
| `/api/v1/tts/clone-voice` | POST | 上傳語音樣本建立聲音模型 |
| `/api/v1/avatar/generate-talking` | POST | TTS + Wav2Lip 臉部動畫 |
| `/api/v1/avatar/generate-frame` | POST | 單幀臉部動畫 |
| `/api/v1/models/status` | GET | GPU 模型狀態 |
| `/outputs/*` | GET | 靜態檔案（音訊/影片下載） |
