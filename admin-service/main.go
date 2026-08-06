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

	app := &App{store: store, cfg: cfg}

	mux := http.NewServeMux()

	// 埋点上报接口（公网，X-Track-Token 鉴权）
	mux.HandleFunc("/track", app.HandleTrack)

	// Dashboard 接口（BasicAuth 鉴权，建议走内网/VPN）
	dashMux := http.NewServeMux()
	dashMux.HandleFunc("/dashboard/overview", app.HandleOverview)
	dashMux.HandleFunc("/dashboard/daily", app.HandleDaily)
	dashMux.HandleFunc("/dashboard/top-docs", app.HandleTopDocs)
	dashMux.HandleFunc("/dashboard/low-score", app.HandleLowScore)
	mux.Handle("/dashboard/", BasicAuth(cfg.DashboardUser, cfg.DashboardPass, dashMux))

	// 健康检查
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// 注册 Dashboard 前端（go:embed 打包的静态资源）
	app.registerDashboard(mux)

	addr := ":" + cfg.Port
	log.Printf("admin-service 启动于 %s", addr)

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
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
