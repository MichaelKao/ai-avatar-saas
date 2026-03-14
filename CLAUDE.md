# AI Avatar SaaS

## 線上環境
| 服務 | URL | 說明 |
|------|-----|------|
| Web 前端 | https://ai-avatar-saas-production-f9f9.up.railway.app | Next.js 前台，Railway 部署 |
| API Gateway | https://yam5ie51sqxres-8888.proxy.runpod.net | Go Fiber，RunPod 共置（nginx 路由） |
| API Gateway (Railway) | https://ai-avatar-saas-production.up.railway.app | Go Fiber，Railway 備用 |
| GPU 服務 | https://yam5ie51sqxres-8888.proxy.runpod.net | RunPod RTX 4090 (25.4GB)，含 STT/TTS/Avatar/LLM proxy |
| 健康檢查 | https://yam5ie51sqxres-8888.proxy.runpod.net/health | Gateway（nginx 路由到 port 3333） |
| GPU 健康檢查 | https://yam5ie51sqxres-8888.proxy.runpod.net/api/v1/models/status | GPU 模型狀態 |
| 桌面版下載 | https://github.com/MichaelKao/ai-avatar-saas/releases | Tauri 2 桌面安裝檔 |

## 搬網域時需要改的地方
> **重要**：如果更換域名或遷移服務，以下是需要修改的所有位置：

### 1. RunPod 共置架構（Gateway + GPU 同機）
Gateway 和 GPU 服務共置在同一台 RunPod 機器上，透過 nginx port 8888 做路由：
- `/ws`, `/health`, `/api/v1/auth/`, `/api/v1/sessions/` 等 → Gateway (port 3333)
- 其餘 → GPU 服務 (port 8889)
- 啟動腳本：`/workspace/start.sh`（LLM + Gateway + GPU）
- Gateway 啟動腳本：`/workspace/start_gateway.sh`
- nginx 設定：`/workspace/nginx_gateway.conf`

RunPod Gateway 環境變數（`/workspace/start_gateway.sh`）：
| 變數 | 目前值 | 說明 |
|------|--------|------|
| `AI_SERVICE_URL` | `http://localhost:8889` | LLM 代理（同機 localhost） |
| `GPU_SERVICE_URL` | `http://localhost:8889` | TTS + Wav2Lip + STT（同機 localhost） |
| `GPU_PUBLIC_URL` | `https://yam5ie51sqxres-8888.proxy.runpod.net` | 客戶端下載音訊/影片用的公開 URL |
| `DATABASE_URL` | Railway PostgreSQL 外部連線 | 資料庫仍在 Railway |
| `REDIS_URL` | Railway Redis 外部連線 | Redis 仍在 Railway |

### 1b. Railway Gateway（備用）
Railway 上仍保留 Gateway 部署，作為備用。

### 2. 桌面 App 預設 URL（需重新 build）
- **檔案**：`apps/desktop/src/App.tsx`
- `apiUrl` 預設值 → RunPod URL（Gateway 經 nginx 路由）
- `gpuUrl` 預設值 → RunPod URL
- 改完後需重新 `npm run tauri build` 並上傳 GitHub Release

### 3. Web 前端
- **檔案**：`apps/web/app/page.tsx`
- 桌面版下載連結 → GitHub Release URL

### 4. RunPod GPU 服務
- **Pod ID**：`yam5ie51sqxres`
- **外部 proxy**：port 8888（nginx）
- **內部 ports**：8889 (GPU+STT combined), 8002 (LLM), 3333 (Gateway)
- 如果換 RunPod Pod，需更新所有 `yam5ie51sqxres` 相關 URL

### 5. 本地 .env 檔
- `services/gateway/.env` — `AI_SERVICE_URL`、`GPU_SERVICE_URL`、`GPU_PUBLIC_URL`
- `services/ai/.env` — `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`

## 技術棧
Go 1.22 (Fiber) / Python 3.11 (FastAPI) / Next.js 14 / Tauri 2 (Rust)
PostgreSQL 16 / Redis 7 / Stripe / Claude API / OpenAI API
CosyVoice (300M-SFT + 2.0-0.5B) TTS / Wav2Lip (臉部動畫) / faster-whisper large-v3 (STT)

## RunPod GPU 環境安裝
> 如果換新 Pod 或重建環境，依照以下步驟安裝：

```bash
# 1. GPU 服務程式碼
mkdir -p /workspace/gpu_service /workspace/llm_service /workspace/outputs
# 從 GitHub 拉取最新程式碼到 /workspace/gpu_service/ 和 /workspace/llm_service/

# 2. CosyVoice（TTS 語音合成）
cd /workspace
git clone https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
git submodule update --init --recursive
pip install -r requirements.txt
cd third_party/Matcha-TTS && pip install -e . && cd ../..
pip install setuptools pyarrow pyworld openai-whisper
python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice-300M-SFT', local_dir='pretrained_models/CosyVoice-300M-SFT')"
python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')"

# 3. Wav2Lip（臉部動畫）
# 需要 /workspace/Wav2Lip/checkpoints/wav2lip_gan.pth

# 4. MuseTalk（即時唇形，尚未完全整合）
cd /workspace
git clone https://github.com/TMElyralab/MuseTalk.git
pip install mmengine mmcv==2.1.0 mmdet==3.2.0 mmpose==1.3.1 accelerate einops
cd MuseTalk
python -c "from huggingface_hub import snapshot_download; snapshot_download('TMElyralab/MuseTalk', local_dir='models')"
# DWPose 模型
mkdir -p models/dwpose && cd models/dwpose
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('yzd-v/DWPose', 'dw-ll_ucoco_384.pth', local_dir='.')"
# SD-VAE
mkdir -p /workspace/MuseTalk/models/sd-vae && cd /workspace/MuseTalk/models/sd-vae
python -c "from huggingface_hub import hf_hub_download; [hf_hub_download('stabilityai/sd-vae-ft-mse', f, local_dir='.') for f in ['config.json','diffusion_pytorch_model.bin','diffusion_pytorch_model.safetensors']]"

# 5. 啟動服務
cd /workspace/llm_service && nohup python3 main.py > /workspace/llm.log 2>&1 &
cd /workspace/gpu_service && nohup python3 combined.py > /workspace/combined.log 2>&1 &
```

## 專案結構
- `apps/web/` — Next.js 14 前端（Vercel 部署）
- `apps/desktop/` — Tauri 2 桌面 App（Windows，含 VB-Cable 安裝）
  - `src-tauri/src/main.rs` — Rust 後端（VAD 語音偵測、STT、串流播放）
  - `src-tauri/src/vad.rs` — 能量閾值 VAD（取代固定 5 秒 chunk + 4 秒 debounce）
  - `src-tauri/src/audio_capture.rs` — WASAPI Loopback 擷取 + 即時重取樣 + VAD
  - `src-tauri/src/audio_player.rs` — 串流音訊播放器（邊收邊播 + 打斷）
  - `src-tauri/src/websocket_client.rs` — WebSocket 客戶端（tts_audio_chunk 自動入隊）
  - `src/App.tsx` — React 前端 UI
- `services/gateway/` — Go API Gateway（Railway 部署）
  - `internal/handlers/websocket.go` — WebSocket 即時通訊（核心串流 Pipeline）
  - `internal/handlers/session.go` — Session 管理
  - `internal/auth/` — JWT 認證
- `services/ai/llm_service/` — Python LLM 服務（RunPod port 8002）
  - `main.py` — FastAPI，`/api/v1/generate` 端點
  - `claude_handler.py` — Anthropic Claude（逗號級切段串流）
  - `gpt_handler.py` — OpenAI GPT（逗號級切段串流）
- `services/ai/gpu_service/` — Python GPU 服務（RunPod port 8889→8888）
  - `main.py` — FastAPI，TTS + Avatar + STT 端點
  - `combined.py` — 合併 GPU + STT + LLM proxy 的入口
  - `stt_service.py` — Whisper STT
  - `cosyvoice_handler.py` — CosyVoice TTS（300M-SFT 內建聲音 + 2.0-0.5B 語音克隆）
  - `wav2lip_handler.py` — Wav2Lip 臉部動畫（回退用）
  - `musetalk_handler.py` — MuseTalk 即時唇形動畫（30-50ms/frame）
- `packages/shared-types/` — 共用 TypeScript 型別
- `infrastructure/` — Docker + 部署腳本

## 全串流資料流（Mode 2/3）
```
LINE/Zoom/Teams/Meet 視訊通話
    ↓ 系統音訊
桌面 App (WASAPI Loopback → VAD 語音偵測 → 300ms 靜音切段)
    ↓ 完整語句 PCM（~0.3s 延遲）
RunPod Whisper STT (/api/v1/stt/transcribe)
    ↓ 文字（無防抖，直接送出）
桌面 App → WebSocket → Gateway
    ↓ 文字
Gateway → LLM 串流 (/api/v1/generate/stream) → 逗號級切段 → 逐段 TTS
    ↓ 每段 TTS 完成立即送 tts_audio_chunk
WebSocket → 桌面 App (Rust 層自動下載 + 入隊播放)
    ↓ gapless 串流播放
桌面 App → VB-Cable → 虛擬麥克風 → 視訊 App 收到 AI 語音
```

### 打斷機制
- 用戶開始說話 → 桌面 App 發送 `interrupt` 訊息
- Gateway 取消進行中的 LLM/TTS（context.WithCancel）
- 桌面 App 取消音訊播放佇列

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
| AI_SERVICE_URL | LLM 服務位址（內部呼叫） | http://localhost:8889 |
| GPU_SERVICE_URL | GPU 服務位址（內部呼叫） | http://localhost:8889 |
| GPU_PUBLIC_URL | GPU 服務公開 URL（客戶端下載音訊/影片用） | https://xxx-8888.proxy.runpod.net |
| STRIPE_SECRET_KEY | Stripe 付費 | sk_live_... |
| STRIPE_WEBHOOK_SECRET | Stripe Webhook 驗證 | whsec_... |
| PORT | 服務埠號 | 3333 |
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
| `/api/v1/generate/stream` | POST | LLM 串流生成（SSE，逗號級切段） |
| `/api/v1/tts/synthesize` | POST | 語音合成（CosyVoice 2.0） |
| `/api/v1/tts/fast-synthesize` | POST | 快速語音合成（Edge TTS） |
| `/api/v1/tts/stream-synthesize` | POST | 串流語音合成（CosyVoice 串流，首 chunk < 100ms） |
| `/api/v1/tts/clone-voice` | POST | 上傳語音樣本建立聲音模型 |
| `/api/v1/tts/concatenate` | POST | 合併多段音訊 |
| `/api/v1/avatar/generate-talking` | POST | TTS + Wav2Lip 臉部動畫 |
| `/api/v1/avatar/animate-from-audio` | POST | 從既有音訊生成臉部動畫 |
| `/api/v1/avatar/prepare-face` | POST | 預處理臉部特徵（MuseTalk） |
| `/api/v1/avatar/stream-lipsync` | POST | 串流唇形動畫（MuseTalk MJPEG） |
| `/api/v1/models/status` | GET | GPU 模型狀態（含 MuseTalk） |
| `/outputs/*` | GET | 靜態檔案（音訊/影片下載） |
