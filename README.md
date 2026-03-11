# AI Avatar SaaS

智能數位分身會議助理 — 搭配 Zoom / Google Meet / Teams 使用的 AI 會議助手

## 三種模式

| 模式 | 名稱 | 說明 |
|------|------|------|
| Mode 1 | Prompt 提詞 | AI 顯示建議文字，你自己講 |
| Mode 2 | 語音分身 | AI 用你的聲音自動回答（CosyVoice TTS） |
| Mode 3 | 完整分身 | AI 臉+聲音完全替你開會（Wav2Lip + TTS） |

## 架構

```
apps/
  web/          Next.js 14 前端（Tailwind + Zustand + TanStack Query）
  desktop/      Tauri 2 桌面版（Rust + React）

services/
  gateway/      Go Fiber API Gateway（JWT、WebSocket、Stripe）
  ai/
    gpu_service/  Python GPU 服務（CosyVoice 2.0 + Wav2Lip）
    llm_service/  Python LLM 服務（vLLM / Qwen）
```

## 部署環境

- **Gateway + Web**: Railway（自動部署）
- **GPU 服務**: RunPod A40 48GB + nginx 反向代理
- **資料庫**: PostgreSQL + Redis

## Quick Start

### 開發環境

```bash
# 啟動 PostgreSQL + Redis
docker compose -f docker-compose.dev.yml up -d

# Gateway（需要 Go 1.22+）
cd services/gateway && go run cmd/main.go

# Web 前端（需要 Node.js 18+）
cd apps/web && npm install && npm run dev
```

### 桌面版

```bash
# 需要 Rust 1.70+ 和 Visual Studio Build Tools (Windows)
cd apps/desktop
npm install
npx tauri dev      # 開發模式
npx tauri build    # 打包 .exe / .msi
```

建置產出：
- `src-tauri/target/release/ai-avatar-desktop.exe`（直接執行）
- `src-tauri/target/release/bundle/msi/AI Avatar Desktop_0.1.0_x64_en-US.msi`（MSI 安裝包）
- `src-tauri/target/release/bundle/nsis/AI Avatar Desktop_0.1.0_x64-setup.exe`（NSIS 安裝包）

### GPU 服務

```bash
# RunPod 上執行
cd services/ai/gpu_service
pip install -r requirements.txt
python main.py  # port 8889
```

## API 端點

### 認證
- `POST /api/v1/auth/register` — 註冊
- `POST /api/v1/auth/login` — 登入
- `POST /api/v1/auth/refresh` — 刷新 Token
- `POST /api/v1/auth/forgot-password` — 忘記密碼（Resend 發信）
- `POST /api/v1/auth/reset-password` — 重設密碼

### Avatar
- `GET /api/v1/avatar/profile` — 取得 Avatar 設定
- `POST /api/v1/avatar/upload-face` — 上傳臉部照片
- `POST /api/v1/avatar/upload-voice` — 上傳聲音樣本
- `GET /api/v1/avatar/model-status` — 模型狀態
- `POST /api/v1/avatar/set-defaults` — 設定預設值

### AI 個性
- `GET /api/v1/personality/` — 列出個性設定
- `POST /api/v1/personality/` — 建立個性
- `PUT /api/v1/personality/:id` — 更新
- `DELETE /api/v1/personality/:id` — 刪除
- `POST /api/v1/personality/:id/set-default` — 設為預設

### 會議 Session
- `POST /api/v1/session/start` — 開始會議
- `DELETE /api/v1/session/:id/end` — 結束會議
- `GET /api/v1/session/history` — 歷史紀錄

### 帳務
- `GET /api/v1/billing/plans` — 方案列表
- `POST /api/v1/billing/subscribe` — 訂閱
- `POST /api/v1/billing/cancel` — 取消
- `GET /api/v1/billing/status` — 狀態
- `POST /api/v1/billing/portal` — Stripe 客戶入口

### WebSocket
- `GET /ws/session/:sessionId?token=JWT` — 即時 AI 建議

### 監控
- `GET /api/v1/logs/` — 錯誤日誌
- `DELETE /api/v1/logs/` — 清除日誌
- `GET /health` — 健康檢查
- `GET /health/ready` — 就緒檢查

## 環境變數

```env
# Gateway
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=your-secret
AI_SERVICE_URL=https://your-gpu-url/llm
GPU_SERVICE_URL=https://your-gpu-url
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
RESEND_API_KEY=re_...
MAIL_FROM=noreply@yourdomain.com
CORS_ORIGINS=https://your-frontend-url
```
