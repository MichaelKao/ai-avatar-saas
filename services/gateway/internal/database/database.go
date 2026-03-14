package database

import (
	"fmt"
	"os"

	"github.com/jmoiron/sqlx"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// Connect 建立 PostgreSQL 連線
func Connect() (*sqlx.DB, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return nil, fmt.Errorf("DATABASE_URL 環境變數未設定")
	}

	db, err := sqlx.Connect("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("連線資料庫失敗: %w", err)
	}

	// 設定連線池
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)

	return db, nil
}

// Migrate 執行資料庫 schema migration（逐個表執行，避免衝突）
func Migrate(db *sqlx.DB) error {
	statements := []string{
		// 用戶表
		`CREATE TABLE IF NOT EXISTS users (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			email VARCHAR(255) UNIQUE NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			name VARCHAR(255),
			plan VARCHAR(50) DEFAULT 'free',
			stripe_customer_id VARCHAR(255),
			is_locked BOOLEAN DEFAULT FALSE,
			failed_login_attempts INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// Avatar 設定表
		`CREATE TABLE IF NOT EXISTS avatar_profiles (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			face_image_url VARCHAR(500),
			voice_sample_url VARCHAR(500),
			voice_model_id VARCHAR(255),
			face_model_status VARCHAR(50) DEFAULT 'pending',
			voice_model_status VARCHAR(50) DEFAULT 'pending',
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// AI 個性設定表
		`CREATE TABLE IF NOT EXISTS ai_personalities (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			system_prompt TEXT NOT NULL,
			llm_model VARCHAR(100) DEFAULT 'claude-haiku-4-5-20251001',
			temperature DECIMAL(3,2) DEFAULT 0.7,
			language VARCHAR(50) DEFAULT 'zh-TW',
			is_default BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 換裝設定表（模式3）
		`CREATE TABLE IF NOT EXISTS outfit_presets (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(255),
			outfit_image_url VARCHAR(500),
			is_active BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 背景設定表（模式3）
		`CREATE TABLE IF NOT EXISTS background_presets (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(255),
			background_image_url VARCHAR(500),
			is_active BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 會議 Session 記錄表
		`CREATE TABLE IF NOT EXISTS meeting_sessions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id),
			mode VARCHAR(20) NOT NULL,
			started_at TIMESTAMP DEFAULT NOW(),
			ended_at TIMESTAMP,
			duration_seconds INTEGER,
			total_responses INTEGER DEFAULT 0,
			llm_model_used VARCHAR(100)
		)`,
		// 訂閱記錄表
		`CREATE TABLE IF NOT EXISTS subscriptions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			stripe_subscription_id VARCHAR(255) UNIQUE,
			plan VARCHAR(50) NOT NULL,
			status VARCHAR(50) NOT NULL,
			current_period_start TIMESTAMP,
			current_period_end TIMESTAMP,
			created_at TIMESTAMP DEFAULT NOW()
		)`,
		// 密碼重設 Token 表
		`CREATE TABLE IF NOT EXISTS password_reset_tokens (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			token VARCHAR(255) UNIQUE NOT NULL,
			expires_at TIMESTAMP NOT NULL,
			used BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW()
		)`,
		// 場景表（SaaS 多用戶個人化）
		`CREATE TABLE IF NOT EXISTS scenes (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(255) NOT NULL,
			scene_type VARCHAR(50) NOT NULL DEFAULT 'custom',
			language VARCHAR(50) DEFAULT 'zh-TW',
			reply_language VARCHAR(50) DEFAULT 'zh-TW',
			reply_length VARCHAR(20) DEFAULT 'medium',
			personality VARCHAR(50) DEFAULT 'professional',
			formality INTEGER DEFAULT 3,
			custom_system_prompt TEXT,
			llm_model VARCHAR(100) DEFAULT 'claude-sonnet-4-6',
			temperature DECIMAL(3,2) DEFAULT 0.7,
			transition_enabled BOOLEAN DEFAULT TRUE,
			transition_style VARCHAR(50) DEFAULT 'natural',
			is_default BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 知識庫表（RAG）
		`CREATE TABLE IF NOT EXISTS knowledge_bases (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			title VARCHAR(500) NOT NULL,
			content TEXT NOT NULL,
			content_type VARCHAR(50) DEFAULT 'text',
			file_url VARCHAR(500),
			token_count INTEGER DEFAULT 0,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 用戶場景背景資料表
		`CREATE TABLE IF NOT EXISTS user_profiles (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE,
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			display_name VARCHAR(255),
			title VARCHAR(255),
			company VARCHAR(255),
			experience_years INTEGER DEFAULT 0,
			skills TEXT,
			experiences TEXT,
			custom_phrases TEXT,
			additional_context TEXT,
			created_at TIMESTAMP DEFAULT NOW(),
			updated_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 過渡語表（預快取音訊）
		`CREATE TABLE IF NOT EXISTS transition_phrases (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			language VARCHAR(50) NOT NULL DEFAULT 'zh-TW',
			style VARCHAR(50) NOT NULL DEFAULT 'natural',
			phrase TEXT NOT NULL,
			audio_url VARCHAR(500),
			audio_base64 TEXT,
			duration_ms INTEGER,
			voice_gender VARCHAR(10) DEFAULT 'female',
			is_cached BOOLEAN DEFAULT FALSE,
			created_at TIMESTAMP DEFAULT NOW(),
			deleted_at TIMESTAMP
		)`,
		// 索引
		`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
		`CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)`,
		`CREATE INDEX IF NOT EXISTS idx_avatar_profiles_user_id ON avatar_profiles(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_personalities_user_id ON ai_personalities(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_meeting_sessions_user_id ON meeting_sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_meeting_sessions_started_at ON meeting_sessions(started_at)`,
		`CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status)`,
		`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)`,
		`CREATE INDEX IF NOT EXISTS idx_scenes_user_id ON scenes(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_scenes_scene_type ON scenes(scene_type)`,
		`CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scene_id ON knowledge_bases(scene_id)`,
		`CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user_id ON knowledge_bases(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_user_profiles_scene_id ON user_profiles(scene_id)`,
		`CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_transition_phrases_lang_style ON transition_phrases(language, style)`,
	}

	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("migration 失敗: %w", err)
		}
	}

	return nil
}
