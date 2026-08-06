package main

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed static/*
var staticFiles embed.FS

// registerDashboard 注册 Dashboard 前端路由
// 访问 / 时返回 index.html，其他静态资源走 /assets/*
// Dashboard 需要登录态（BasicAuth），与 /dashboard/* API 共享同一组凭据
func (app *App) registerDashboard(mux *http.ServeMux) {
	staticFS, _ := fs.Sub(staticFiles, "static")
	fileServer := http.FileServer(http.FS(staticFS))

	// 预读 index.html 内容，用于根路径和 SPA fallback
	// 避免 http.FileServer 遇到 /index.html 时 301 重定向到 / 导致死循环
	indexHTML, _ := fs.ReadFile(staticFS, "index.html")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// API 路径不在此处理
		if strings.HasPrefix(r.URL.Path, "/track") ||
			strings.HasPrefix(r.URL.Path, "/dashboard/") ||
			r.URL.Path == "/health" {
			http.NotFound(w, r)
			return
		}

		// 根路径：直接返回 index.html 内容，不走 FileServer（避免重定向循环）
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexHTML)
			return
		}

		// 检查静态文件是否存在
		filePath := strings.TrimPrefix(r.URL.Path, "/")
		f, err := staticFS.Open(filePath)
		if err != nil {
			// 文件不存在，返回 index.html（SPA fallback）
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexHTML)
			return
		}
		f.Close()

		// 文件存在，交给 FileServer 处理
		fileServer.ServeHTTP(w, r)
	})

	// Dashboard 页面也走 BasicAuth 保护
	mux.Handle("/", BasicAuth(app.cfg.DashboardUser, app.cfg.DashboardPass, handler))
}
