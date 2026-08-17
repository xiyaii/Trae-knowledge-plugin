package main

import (
	"fmt"
	"os"
)

// Config 运营服务端配置，全部通过环境变量注入
type Config struct {
	Port          string // HTTP 监听端口
	DBDSN         string // PostgreSQL 连接串
	TrackToken    string // /track 和 /kb/chat 接口鉴权 token（编译期注入插件）
	DashboardUser string // Dashboard BasicAuth 用户名（兜底）
	DashboardPass string // Dashboard BasicAuth 密码（兜底）
	// 飞书 SSO 配置
	LarkAppID       string // 飞书应用 App ID
	LarkAppSecret   string // 飞书应用 App Secret
	LarkRedirectURL string // OAuth 回调地址，如 http://115.191.37.157:8080/auth/callback
	AllowLarkUsers  string // 可选：飞书 user_id 白名单，逗号分隔；为空则允许所有飞书用户
	// 知识库代理配置
	KBApiKey string // 火山引擎知识库 APIKey（仅存于服务端，不进入插件）
}

// LoadConfig 从环境变量加载配置
func LoadConfig() (*Config, error) {
	cfg := &Config{
		Port:            getEnv("PORT", "8080"),
		DBDSN:           os.Getenv("DB_DSN"),
		TrackToken:      os.Getenv("TRACK_TOKEN"),
		DashboardUser:   getEnv("DASHBOARD_USER", "admin"),
		DashboardPass:   os.Getenv("DASHBOARD_PASS"),
		LarkAppID:       os.Getenv("LARK_APP_ID"),
		LarkAppSecret:   os.Getenv("LARK_APP_SECRET"),
		LarkRedirectURL: os.Getenv("LARK_REDIRECT_URL"),
		AllowLarkUsers:  os.Getenv("ALLOW_LARK_USERS"),
		KBApiKey:        os.Getenv("KB_API_KEY"),
	}

	if cfg.DBDSN == "" {
		return nil, fmt.Errorf("DB_DSN 环境变量未设置（PostgreSQL 连接串）")
	}
	if cfg.TrackToken == "" {
		return nil, fmt.Errorf("TRACK_TOKEN 环境变量未设置（/track 接口鉴权）")
	}
	if cfg.DashboardPass == "" {
		return nil, fmt.Errorf("DASHBOARD_PASS 环境变量未设置")
	}
	if cfg.LarkAppID == "" || cfg.LarkAppSecret == "" || cfg.LarkRedirectURL == "" {
		return nil, fmt.Errorf("LARK_APP_ID/LARK_APP_SECRET/LARK_REDIRECT_URL 环境变量未设置（飞书 SSO）")
	}
	if cfg.KBApiKey == "" {
		return nil, fmt.Errorf("KB_API_KEY 环境变量未设置（火山引擎知识库 APIKey）")
	}
	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
