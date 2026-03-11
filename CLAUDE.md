# AI Avatar SaaS

## 線上環境
| 環境 | URL |
|------|-----|
| Web 前端 | https://app.yourdomain.com |
| API Gateway | https://api.yourdomain.com |
| 健康檢查 | https://api.yourdomain.com/health |

## 技術棧
Go 1.22 (Fiber) / Python 3.11 (FastAPI) / Next.js 14 / Tauri (Rust)
PostgreSQL / Redis / Cloudflare R2 / Stripe / Claude API

## 專案結構
- `apps/web/` — Next.js 14 前端後台
- `apps/desktop/` — Tauri 桌面 APP（Phase 2）
- `services/gateway/` — Go API Gateway
- `services/ai/` — Python AI 微服務
- `packages/shared-types/` — 共用 TypeScript 型別
- `tests/` — Playwright 整合 + E2E 測試
- `infrastructure/` — Docker + 部署腳本

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
- DATABASE_URL — PostgreSQL 連線
- REDIS_URL — Redis 連線
- JWT_SECRET — JWT 簽名密鑰（至少 32 字元）
- ANTHROPIC_API_KEY — Claude API
- STRIPE_SECRET_KEY — Stripe 付費
- STRIPE_WEBHOOK_SECRET — Stripe Webhook 驗證
- AI_SERVICE_URL — Python AI 微服務位址

## 資料庫
- PostgreSQL 16
- Schema migration 在 services/gateway/migrations/
- 所有表都有 deleted_at 軟刪除欄位
- 查詢必須加 WHERE deleted_at IS NULL

## 三個服務模式
- 模式1 — 提示模式：AI 建議答案，用戶決定採用
- 模式2 — 替身模式：AI 取代臉部與聲音，自動回答
- 模式3 — 全能模式：加換裝、換背景、切換模型
