package main

import (
	"encoding/json"
	"log"
	"net/http"
)

// App 持有所有依赖，handler 挂在 App 上
type App struct {
	store    *Store
	cfg      *Config
	sessions *SessionStore
}

// HandleTrack 处理埋点上报
// POST /track
// Header: X-Track-Token: <token>
// Body: TrackEvent JSON
func (app *App) HandleTrack(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Token 鉴权
	token := r.Header.Get("X-Track-Token")
	if token == "" || token != app.cfg.TrackToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var e TrackEvent
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		http.Error(w, "Bad Request: "+err.Error(), http.StatusBadRequest)
		return
	}

	if e.Event == "" || e.TS == 0 {
		http.Error(w, "Missing required fields: event, ts", http.StatusBadRequest)
		return
	}

	if err := app.store.InsertEvent(e); err != nil {
		log.Printf("事件写入失败: %v", err)
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
