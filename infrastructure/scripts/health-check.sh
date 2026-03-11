#!/bin/bash
# 部署後健康檢查腳本

API_URL=${1:-"http://localhost:8080"}
MAX_RETRIES=10
RETRY_INTERVAL=3

echo "檢查 Gateway 健康狀態: $API_URL/health"

for i in $(seq 1 $MAX_RETRIES); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
        echo "健康檢查通過 (第 $i 次嘗試)"
        exit 0
    fi
    echo "嘗試 $i/$MAX_RETRIES: HTTP $STATUS"
    sleep $RETRY_INTERVAL
done

echo "健康檢查失敗！"
exit 1
