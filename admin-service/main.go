package main

import (
	"log"
	"net/http"
	"time"
)

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	store, err := NewStore(cfg.DBDSN)
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	defer store.Close()

	if err := store.InitDB(); err != nil {
		log.Fatalf("数据库初始化失败: %v", err)
	}

	// 启动每日聚合任务（凌晨 00:05 刷新昨日数据）
	go store.StartDailyAggregation()

	app := &App{store: store, cfg: cfg, sessions: NewSessionStore()}

	// 飞书定时通知（分钟级 tick，配置存 DB，看板在线调整后最迟 1 分钟生效）
	go app.StartFeedbackNotifier()

	mux := http.NewServeMux()

	// 埋点上报接口（公网，X-Track-Token 鉴权）
	mux.HandleFunc("/track", app.HandleTrack)

	// 知识库代理接口（公网，X-Track-Token 鉴权）
	// 插件 go-backend 通过此接口调用火山引擎知识库，APIKey 仅存于服务端
	mux.HandleFunc("/kb/chat", app.HandleKBChat)

	// 飞书 SSO 登录（公开路由，不需要鉴权）
	mux.HandleFunc("/auth/login", app.handleLogin)
	mux.HandleFunc("/auth/callback", app.handleCallback)
	mux.HandleFunc("/auth/logout", app.handleLogout)
	mux.HandleFunc("/auth/me", app.handleMe)

	// Dashboard 接口（SessionAuth 鉴权，需飞书 SSO 登录）
	dashMux := http.NewServeMux()
	dashMux.HandleFunc("/dashboard/overview", app.HandleOverview)
	dashMux.HandleFunc("/dashboard/daily", app.HandleDaily)
	dashMux.HandleFunc("/dashboard/top-docs", app.HandleTopDocs)
	dashMux.HandleFunc("/dashboard/low-score", app.HandleLowScore)
	dashMux.HandleFunc("/dashboard/feedback", app.HandleFeedback)
	dashMux.HandleFunc("/dashboard/feedback/review", app.HandleReviewFeedback)

	// 飞书定时通知配置与测试（SessionAuth 鉴权，与看板同权限）
	dashMux.HandleFunc("/dashboard/notify/config", app.HandleNotifyConfig)
	dashMux.HandleFunc("/dashboard/notify/test", app.HandleNotifyTest)
	mux.Handle("/dashboard/", app.SessionAuth(dashMux))

	// 健康检查
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// 注册 Dashboard 前端（go:embed 打包的静态资源）
	app.registerDashboard(mux)

	addr := ":" + cfg.Port
	log.Printf("admin-service 启动于 %s", addr)

	srv := &http.Server{
		Addr:        addr,
		Handler:     mux,
		ReadTimeout: 10 * time.Second,
		// WriteTimeout 需覆盖 /kb/chat 的 55s 知识库调用 + 网络往返
		// 原值 10s 会强制中断长耗时请求，导致 502
		WriteTimeout: 60 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
