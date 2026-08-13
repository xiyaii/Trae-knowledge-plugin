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

// BasicAuth 中间件：保护 Dashboard 接口
func BasicAuth(user, pass string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != user || p != pass {
			w.Header().Set("WWW-Authenticate", `Basic realm="admin"`)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
