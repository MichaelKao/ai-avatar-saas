package cache

import (
	"context"
	"fmt"
	"os"

	"github.com/redis/go-redis/v9"
)

// Connect 建立 Redis 連線
func Connect() (*redis.Client, error) {
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		return nil, fmt.Errorf("REDIS_URL 環境變數未設定")
	}

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("Redis URL 解析失敗: %w", err)
	}

	rdb := redis.NewClient(opt)

	// 測試連線
	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("Redis 連線失敗: %w", err)
	}

	return rdb, nil
}
