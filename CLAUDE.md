# AI Avatar SaaS

## 線上環境
| 服務 | URL | 說明 |
|------|-----|------|
| Web 前端 | https://ai-avatar-saas-production-f9f9.up.railway.app | Next.js 前台，Railway 部署 |
| API Gateway | https://twjgc6ahrdxohs-8888.proxy.runpod.net | Go Fiber，RunPod 共置（nginx 路由） |
| API Gateway (Railway) | https://ai-avatar-saas-production.up.railway.app | Go Fiber，Railway 備用 |
| GPU 服務 | https://twjgc6ahrdxohs-8888.proxy.runpod.net | RunPod RTX 4090 (25.4GB)，含 STT/TTS/Avatar/LLM proxy |
| 健康檢查 | https://twjgc6ahrdxohs-8888.proxy.runpod.net/health | Gateway（nginx 路由到 port 3333） |
| GPU 健康檢查 | https://twjgc6ahrdxohs-8888.proxy.runpod.net/api/v1/models/status | GPU 模型狀態 |
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
| `GPU_PUBLIC_URL` | `https://twjgc6ahrdxohs-8888.proxy.runpod.net` | 客戶端下載音訊/影片用的公開 URL |
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
- **Pod ID**：`twjgc6ahrdxohs`
- **外部 proxy**：port 8888（nginx）
- **內部 ports**：8889 (GPU+STT combined), 8002 (LLM), 3333 (Gateway)
- 如果換 RunPod Pod，需更新所有 `twjgc6ahrdxohs` 相關 URL

### 5. 本地 .env 檔
- `services/gateway/.env` — `AI_SERVICE_URL`、`GPU_SERVICE_URL`、`GPU_PUBLIC_URL`
- `services/ai/.env` — `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY`

## 技術棧
Go 1.22 (Fiber) / Python 3.11.10 (FastAPI) / Next.js 14 / Tauri 2 (Rust)
PostgreSQL 16 / Redis 7 / Stripe / Claude API / OpenAI API
PyTorch 2.4.1+cu124 / CUDA 12.4
CosyVoice (300M-SFT + 2.0-0.5B) TTS / MeloTTS / Edge TTS
MuseTalk (即時唇形動畫) / Wav2Lip (臉部動畫回退)
faster-whisper small (STT)

## RunPod GPU 環境 — 完整重建指南
> **重要**：如果 Pod 過期或需要換新 Pod，按以下步驟完整重建。
> 建議選 RTX 4090 24GB，模型總計 ~12GB VRAM。
> 基礎映像：`runpod/pytorch:2.4.1-py3.11-cuda12.4.1-devel-ubuntu22.04`

### Step 0: 基礎目錄和工具
```bash
mkdir -p /workspace/gpu_service /workspace/llm_service /workspace/outputs /workspace/uploads

# 安裝 nginx（用於路由 Gateway + GPU）
apt-get update && apt-get install -y nginx
```

### Step 1: 拉取程式碼
```bash
# GPU 服務（main.py, combined.py, stt_service.py, cosyvoice_handler.py, musetalk_handler.py, wav2lip_handler.py）
cd /workspace
REPO="https://raw.githubusercontent.com/MichaelKao/ai-avatar-saas/main"
for f in main.py combined.py stt_service.py cosyvoice_handler.py musetalk_handler.py wav2lip_handler.py; do
  curl -sL "$REPO/services/ai/gpu_service/$f" -o /workspace/gpu_service/$f
done

# LLM 服務（main.py, claude_handler.py, gpt_handler.py）
for f in main.py claude_handler.py gpt_handler.py; do
  curl -sL "$REPO/services/ai/llm_service/$f" -o /workspace/llm_service/$f
done

# Gateway 二進位（從本機 cross-compile 上傳）
# 本機執行：GOOS=linux GOARCH=amd64 go build -o gateway-linux-amd64 ./cmd/main.go
# 然後 scp 到 /workspace/gateway-linux
```

### Step 2: CosyVoice（TTS 語音合成，~2GB VRAM）
```bash
cd /workspace
git clone https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
git submodule update --init --recursive
pip install -r requirements.txt
cd third_party/Matcha-TTS && pip install -e . && cd ../..
pip install setuptools pyarrow pyworld openai-whisper "huggingface_hub<=0.24"

# 下載模型（各 ~1.5GB）
python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice-300M-SFT', local_dir='pretrained_models/CosyVoice-300M-SFT')"
python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/CosyVoice2-0.5B')"
```
**產出**：`/workspace/CosyVoice/pretrained_models/CosyVoice-300M-SFT/` 和 `CosyVoice2-0.5B/`

### Step 3: MeloTTS（快速 TTS，~290ms，CPU/GPU 混合）
```bash
cd /workspace
git clone https://github.com/myshell-ai/MeloTTS.git
cd MeloTTS
pip install -e .
# 首次 import 會自動下載 BERT 模型（~400MB）
python -c "from melo.api import TTS; t=TTS(language='ZH', device='cuda'); print('MeloTTS OK')"
```
**產出**：`/workspace/MeloTTS/`，pip 安裝為 `melotts` package

### Step 4: Wav2Lip（臉部動畫回退，~0.5GB VRAM）
```bash
cd /workspace
git clone https://github.com/Rudrabha/Wav2Lip.git
mkdir -p Wav2Lip/checkpoints
# wav2lip_gan.pth 需手動下載（~150MB）
# 來源：https://iiitaphyd-my.sharepoint.com/...（見 Wav2Lip README）
# 放到 /workspace/Wav2Lip/checkpoints/wav2lip_gan.pth
pip install librosa==0.9.2  # Wav2Lip 需要舊版 librosa
```
**注意**：librosa.filters.mel 呼叫需用 keyword args：`mel(sr=sr, n_fft=n_fft)`

### Step 5: MuseTalk（即時唇形動畫，~4GB VRAM，45ms/frame）
```bash
cd /workspace
git clone https://github.com/TMElyralab/MuseTalk.git
cd MuseTalk

# 安裝 mmlab 系列（版本必須精確匹配）
pip install mmengine mmcv==2.1.0 mmdet==3.2.0 mmpose==1.3.1
pip install accelerate einops diffusers==0.30.2

# 下載主模型（~2GB，含 musetalk + musetalkV15）
python -c "from huggingface_hub import snapshot_download; snapshot_download('TMElyralab/MuseTalk', local_dir='models')"

# DWPose 模型（姿態偵測）
mkdir -p models/dwpose && cd models/dwpose
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('yzd-v/DWPose', 'dw-ll_ucoco_384.pth', local_dir='.')"

# SD-VAE（圖像解碼）
mkdir -p /workspace/MuseTalk/models/sd-vae && cd /workspace/MuseTalk/models/sd-vae
python -c "from huggingface_hub import hf_hub_download; [hf_hub_download('stabilityai/sd-vae-ft-mse', f, local_dir='.') for f in ['config.json','diffusion_pytorch_model.bin','diffusion_pytorch_model.safetensors']]"

# Whisper-tiny（MuseTalk 自用的音訊特徵提取，不同於 STT 的 faster-whisper）
mkdir -p /workspace/MuseTalk/models/whisper && cd /workspace/MuseTalk/models/whisper
python -c "from huggingface_hub import hf_hub_download; [hf_hub_download('openai/whisper-tiny', f, local_dir='.') for f in ['config.json','model.safetensors','preprocessor_config.json']]"

# Face Parsing（臉部分割，BiSeNet）
mkdir -p /workspace/MuseTalk/models/face-parse-bisent && cd /workspace/MuseTalk/models/face-parse-bisent
# resnet18 backbone
python -c "import torch; torch.hub.download_url_to_file('https://download.pytorch.org/models/resnet18-5c106cde.pth', 'resnet18-5c106cde.pth')"
# 79999_iter.pth（從 Google Drive 下載，ID: 154JgKpzCPW82qINcVieuPH3fZ2e0P812）
pip install gdown
gdown 154JgKpzCPW82qINcVieuPH3fZ2e0P812 -O 79999_iter.pth
```
**產出目錄結構**：
```
/workspace/MuseTalk/models/
├── musetalk/          # UNet 模型
├── musetalkV15/       # V1.5 模型（備用）
├── dwpose/            # dw-ll_ucoco_384.pth
├── sd-vae/            # config.json + diffusion_pytorch_model.bin + .safetensors
├── whisper/           # config.json + model.safetensors + preprocessor_config.json
└── face-parse-bisent/ # resnet18-5c106cde.pth + 79999_iter.pth
```
**注意**：目錄名是 `face-parse-bisent`（不是 bisenet），MuseTalk 程式碼硬編碼這個名字。

### Step 6: faster-whisper STT（語音辨識，~1GB VRAM）
```bash
pip install faster-whisper
# 模型會在首次使用時自動下載 whisper-small（~500MB）
# GPU 服務啟動時設定 WHISPER_MODEL_SIZE=small
```

### Step 7: 其他 Python 依賴
```bash
pip install edge-tts pydub soundfile fastapi uvicorn python-multipart aiofiles
pip install anthropic openai  # LLM 服務用
```

### Step 8: nginx 設定
```bash
# 建立 /workspace/nginx_gateway.conf（內容見下方「nginx 設定檔」章節）
# 加入 nginx 主設定
grep -q 'localhost:3333' /etc/nginx/nginx.conf || \
  sed -i '/^}/i \    include /workspace/nginx_gateway.conf;' /etc/nginx/nginx.conf
nginx -s reload
```

### Step 9: Gateway 啟動腳本
```bash
cat > /workspace/start_gateway.sh << 'GWEOF'
#!/bin/bash
export DATABASE_URL='你的 Railway PostgreSQL 外部連線字串'
export REDIS_URL='你的 Railway Redis 外部連線字串'
export JWT_SECRET='dev-secret-key-at-least-32-characters-long'
export ANTHROPIC_API_KEY='你的 Anthropic API Key'
export AI_SERVICE_URL='http://localhost:8889'
export GPU_SERVICE_URL='http://localhost:8889'
export GPU_PUBLIC_URL='https://你的pod-8888.proxy.runpod.net'
export PORT='3333'
export CORS_ORIGINS='*'
exec /workspace/gateway-linux
GWEOF
chmod +x /workspace/start_gateway.sh
```

### Step 10: 一鍵啟動腳本
```bash
cat > /workspace/start.sh << 'EOF'
#!/bin/bash
export PYTHONUNBUFFERED=1

# nginx
grep -q 'localhost:3333' /etc/nginx/nginx.conf || \
  sed -i '/^}/i \    include /workspace/nginx_gateway.conf;' /etc/nginx/nginx.conf
nginx 2>/dev/null || nginx -s reload 2>/dev/null || true
echo '[OK] nginx (port 8888)'

# LLM (port 8002)
cd /workspace/llm_service
nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8002 > /workspace/llm.log 2>&1 &
echo "[OK] LLM PID: $!"
sleep 2

# Gateway (port 3333)
nohup /workspace/start_gateway.sh > /workspace/gateway.log 2>&1 &
echo "[OK] Gateway PID: $!"
sleep 1

# GPU+STT (port 8889，前景模式方便看 log)
cd /workspace/gpu_service
python3 combined.py 2>&1 | tee /workspace/combined.log
EOF
chmod +x /workspace/start.sh
```

### Step 11: 啟動並驗證
```bash
bash /workspace/start.sh
# 等 30-60 秒讓模型載入...
# 驗證：
curl http://localhost:8889/api/v1/models/status  # 所有模型 loaded
curl http://localhost:3333/health                  # Gateway OK
```

### 更新程式碼（日常維護）
```bash
# 更新 GPU 服務程式碼（push 到 GitHub 後）
REPO="https://raw.githubusercontent.com/MichaelKao/ai-avatar-saas/main"
for f in main.py combined.py stt_service.py cosyvoice_handler.py musetalk_handler.py wav2lip_handler.py; do
  curl -sL "$REPO/services/ai/gpu_service/$f" -o /workspace/gpu_service/$f
done
rm -rf /workspace/gpu_service/__pycache__  # 清除 Python cache！
# 然後重啟 GPU 服務

# 更新 Gateway 二進位（本機 cross-compile 後 SCP 上傳）
# 本機：cd services/gateway && GOOS=linux GOARCH=amd64 go build -o gateway-linux-amd64 ./cmd/main.go
# scp -P <port> gateway-linux-amd64 root@<ip>:/workspace/gateway-linux-new
# SSH: kill old gateway → cp gateway-linux-new gateway-linux → 重啟
```

### VRAM 使用量（RTX 4090 24GB）
| 模型 | VRAM |
|------|------|
| Whisper small (STT) | ~1 GB |
| CosyVoice 300M-SFT | ~2 GB |
| MeloTTS | ~0.5 GB |
| Wav2Lip | ~0.5 GB |
| MuseTalk (DWPose+VAE+UNet+Whisper-tiny+BiSeNet) | ~4 GB |
| PyTorch CUDA cache | ~3.5 GB |
| **總計** | **~12 GB / 24 GB** |

### 重啟注意事項
- 重啟前必須確認舊 process 已死：`ss -tlnp | grep 8889` + `kill -9 <pid>`
- 更新 .py 後必須刪除 `__pycache__/*.pyc`，否則用舊代碼
- LLM 服務必須用 `python3 -m uvicorn main:app --host 0.0.0.0 --port 8002`（main.py 無 `if __name__` block）

### 換 Pod 後需要更新的地方
1. `/workspace/start_gateway.sh` 中的 `GPU_PUBLIC_URL`（改成新 pod 的 proxy URL）
2. `apps/desktop/src/App.tsx` 中的 `defaultUrl`（改成新 pod URL）
3. `apps/desktop/src/App.tsx` 中的遷移邏輯（加入舊 pod ID 到遷移清單）
4. `CLAUDE.md` 中所有 pod URL 引用
5. 重新 `npm run tauri build` 桌面 App 並上傳 GitHub Release

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
- **模式3** — 全能模式：TTS + 唇形動畫（MuseTalk），完全自動應答
  - 音訊立刻送 `tts_audio_chunk`（不等 MuseTalk）
  - MuseTalk 唇形幀獨立送 `avatar_frame`（best-effort，不阻擋音訊）
  - TTS 回退：CosyVoice → MeloTTS → Edge TTS（三重回退，保證有聲音）

## nginx 設定檔（`/workspace/nginx_gateway.conf`）
路由規則（port 8888 對外統一入口）：
- `/ws` → Gateway (3333)，WebSocket 升級 + 86400s timeout
- `/health` → Gateway (3333)
- `/api/v1/auth/`, `/api/v1/sessions/`, `/api/v1/users/`, `/api/v1/subscriptions/`, `/api/v1/scenes/`, `/api/v1/personalities/` → Gateway (3333)
- 其餘所有路徑 → GPU 服務 (8889)，含 chunked transfer + WebSocket 支援
- `client_max_body_size 100M`（語音上傳用）

## RunPod GPU 服務端點
| 端點 | 方法 | 說明 |
|------|------|------|
| `/health` | GET | 健康檢查 |
| `/api/v1/stt/transcribe` | POST | 語音轉文字（Whisper small） |
| `/api/v1/generate` | POST | LLM 文字生成（proxy → port 8002） |
| `/api/v1/generate/stream` | POST | LLM 串流生成（SSE，逗號級切段） |
| `/api/v1/tts/synthesize` | POST | 語音合成（CosyVoice 2.0） |
| `/api/v1/tts/fast-synthesize` | POST | 快速語音合成（Edge TTS） |
| `/api/v1/tts/stream-synthesize` | POST | CosyVoice 串流語音合成（~700ms-2s，回傳 PCM chunks） |
| `/api/v1/tts/melo-synthesize` | POST | MeloTTS 快速語音合成（~290ms，回傳 WAV bytes） |
| `/api/v1/tts/clone-voice` | POST | 上傳語音樣本建立聲音模型 |
| `/api/v1/tts/concatenate` | POST | 合併多段音訊 |
| `/api/v1/avatar/generate-talking` | POST | TTS + Wav2Lip 臉部動畫 |
| `/api/v1/avatar/animate-from-audio` | POST | 從既有音訊生成臉部動畫 |
| `/api/v1/avatar/prepare-face` | POST | 預處理臉部特徵（MuseTalk，~2s 一次性） |
| `/api/v1/avatar/stream-lipsync` | POST | 串流唇形動畫（MuseTalk MJPEG） |
| `/api/v1/avatar/musetalk-lipsync` | POST | MuseTalk 唇形動畫（回傳 base64 JPEG frames） |
| `/api/v1/avatar/face/{face_id}` | DELETE | 移除 MuseTalk 臉部快取 |
| `/api/v1/models/status` | GET | GPU 模型狀態（含 MuseTalk） |
| `/outputs/*` | GET | 靜態檔案（音訊/影片下載） |
