# AI Avatar SaaS

智能數位分身會議助理

## Quick Start

```bash
# 啟動開發環境
docker compose -f docker-compose.dev.yml up -d

# Gateway
cd services/gateway && go run cmd/main.go

# Web
cd apps/web && npm run dev
```
