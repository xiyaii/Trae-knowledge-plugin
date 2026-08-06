package main

import (
	"fmt"
	"os"
)

// Config 运营服务端配置，全部通过环境变量注入
type Config struct {
	Port          string // HTTP 监听端口
	DBDSN         string // PostgreSQL 连接串
	TrackToken    string // /track 接口鉴权 token（编译期注入插件）
	DashboardUser string // Dashboard BasicAuth 用户名
	DashboardPass string // Dashboard BasicAuth 密码
}

// LoadConfig 从环境变量加载配置
func LoadConfig() (*Config, error) {
	cfg := &Config{
		Port:          getEnv("PORT", "8080"),
		DBDSN:         os.Getenv("DB_DSN"),
		TrackToken:    os.Getenv("TRACK_TOKEN"),
		DashboardUser: getEnv("DASHBOARD_USER", "admin"),
		DashboardPass: os.Getenv("DASHBOARD_PASS"),
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
	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
