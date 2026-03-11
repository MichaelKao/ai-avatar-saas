.PHONY: dev dev-db dev-gateway dev-web dev-ai test-gateway test-ai test-web test-api test-e2e test-all db-up db-down db-migrate lint

# 開發環境
dev-db:
	docker compose -f docker-compose.dev.yml up -d

dev-gateway:
	cd services/gateway && go run cmd/main.go

dev-web:
	cd apps/web && npm run dev

dev-ai:
	cd services/ai && python -m uvicorn llm_service.main:app --reload --port 8001

dev: dev-db
	@echo "PostgreSQL + Redis 已啟動"
	@echo "接下來請分別執行："
	@echo "  make dev-gateway"
	@echo "  make dev-web"
	@echo "  make dev-ai"

# 測試
test-gateway:
	cd services/gateway && go test ./... -v

test-ai:
	cd services/ai && pytest -v

test-web:
	cd apps/web && npx vitest run

test-api:
	npx playwright test tests/api/

test-e2e:
	npx playwright test tests/e2e/

test-all: test-gateway test-ai test-web test-api test-e2e

# 資料庫
db-up:
	docker compose -f docker-compose.dev.yml up -d postgres

db-down:
	docker compose -f docker-compose.dev.yml down

db-migrate:
	cd services/gateway && go run cmd/migrate/main.go

# 程式碼品質
lint:
	cd services/gateway && go vet ./...
	cd apps/web && npx tsc --noEmit
