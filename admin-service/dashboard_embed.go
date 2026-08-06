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

	// 包装：访问根路径返回 index.html
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 如果请求的是 API 路径，交给其他 handler
		if strings.HasPrefix(r.URL.Path, "/track") ||
			strings.HasPrefix(r.URL.Path, "/dashboard/") ||
			r.URL.Path == "/health" {
			http.NotFound(w, r)
			return
		}

		// 根路径或不存在文件时，返回 index.html（支持前端路由）
		if r.URL.Path == "/" {
			r.URL.Path = "/index.html"
		} else {
			// 检查文件是否存在，不存在则返回 index.html（SPA fallback）
			f, err := staticFS.Open(strings.TrimPrefix(r.URL.Path, "/"))
			if err != nil {
				r.URL.Path = "/index.html"
			} else {
				f.Close()
			}
		}
		fileServer.ServeHTTP(w, r)
	})

	// Dashboard 页面也走 BasicAuth 保护
	mux.Handle("/", BasicAuth(app.cfg.DashboardUser, app.cfg.DashboardPass, handler))
}
