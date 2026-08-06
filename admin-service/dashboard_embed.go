package main

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed static/*
var staticFiles embed.FS

// registerDashboard 注册 Dashboard 前端路由
// 完全不用 http.FileServer（它对 /index.html 有 301 重定向行为）
// 直接用 fs.ReadFile + http.ServeContent 手动处理
func (app *App) registerDashboard(mux *http.ServeMux) {
	staticFS, _ := fs.Sub(staticFiles, "static")
	indexHTML, _ := fs.ReadFile(staticFS, "index.html")

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// API 路径不在此处理
		if strings.HasPrefix(r.URL.Path, "/track") ||
			strings.HasPrefix(r.URL.Path, "/dashboard/") ||
			r.URL.Path == "/health" {
			http.NotFound(w, r)
			return
		}

		// 根路径或路径为 /index.html：返回 index.html
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexHTML)
			return
		}

		// 尝试读取静态文件（去掉前导 /）
		filePath := strings.TrimPrefix(r.URL.Path, "/")
		data, err := fs.ReadFile(staticFS, filePath)
		if err != nil {
			// 文件不存在，返回 index.html（SPA fallback）
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(indexHTML)
			return
		}

		// 根据扩展名设置 Content-Type
		ext := path.Ext(filePath)
		switch ext {
		case ".js":
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case ".html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		case ".svg":
			w.Header().Set("Content-Type", "image/svg+xml")
		case ".png":
			w.Header().Set("Content-Type", "image/png")
		case ".ico":
			w.Header().Set("Content-Type", "image/x-icon")
		case ".json":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
		case ".woff", ".woff2":
			w.Header().Set("Content-Type", "font/"+ext[1:])
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
		}

		w.Write(data)
	})

	// Dashboard 页面走 BasicAuth 保护
	mux.Handle("/", BasicAuth(app.cfg.DashboardUser, app.cfg.DashboardPass, handler))
}
