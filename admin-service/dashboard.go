package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// OverviewResp 总览响应
type OverviewResp struct {
	InstallCount int64   `json:"install_count"` // 累计激活设备数
	LoginCount   int64   `json:"login_count"`   // 累计登录用户数
	QueryCount   int64   `json:"query_count"`   // 累计问答次数
	DAU          int64   `json:"dau"`           // 今日活跃用户数
	AvgScore     float64 `json:"avg_score"`     // 平均检索得分
	LowScoreRate float64 `json:"low_score_rate"` // 低分占比（score < 0.3）
}

// HandleOverview GET /dashboard/overview?from=&to=
// 返回时间范围内的总览数据
func (app *App) HandleOverview(w http.ResponseWriter, r *http.Request) {
	from, to := parseTimeRange(r)
	ctx := r.Context()

	var resp OverviewResp

	// 累计安装设备数
	app.store.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT machine_id) FROM events WHERE event_type='install'`).Scan(&resp.InstallCount)

	// 累计登录用户数
	app.store.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT user_id) FROM events WHERE event_type='login_success'`).Scan(&resp.LoginCount)

	// 时间范围内的问答次数
	app.store.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM events WHERE event_type='query' AND ts >= $1 AND ts < $2`, from, to).Scan(&resp.QueryCount)

	// 今日 DAU
	todayStart := time.Now().Truncate(24 * time.Hour).UnixMilli()
	app.store.pool.QueryRow(ctx,
		`SELECT COUNT(DISTINCT user_id) FROM events WHERE event_type='query' AND ts >= $1`, todayStart).Scan(&resp.DAU)

	// 平均得分 & 低分占比
	app.store.pool.QueryRow(ctx,
		`SELECT COALESCE(AVG(score), 0), COALESCE(SUM(CASE WHEN score < 0.3 THEN 1 ELSE 0 END)::float8 / NULLIF(COUNT(*), 0), 0)
		 FROM events WHERE event_type='query' AND ts >= $1 AND ts < $2`, from, to).Scan(&resp.AvgScore, &resp.LowScoreRate)

	writeJSON(w, resp)
}

// DailyItem 日趋势单项
type DailyItem struct {
	Date        string `json:"date"`
	Install     int64  `json:"install"`
	Login       int64  `json:"login"`
	Query       int64  `json:"query"`
	DAU         int64  `json:"dau"`
}

// HandleDaily GET /dashboard/daily?from=&to=
// 返回每日趋势
func (app *App) HandleDaily(w http.ResponseWriter, r *http.Request) {
	from, to := parseTimeRange(r)
	ctx := r.Context()

	rows, err := app.store.pool.Query(ctx,
		`SELECT DATE(TO_TIMESTAMP(ts / 1000.0)) as d,
		        COUNT(DISTINCT CASE WHEN event_type='install' THEN machine_id END) as install,
		        COUNT(DISTINCT CASE WHEN event_type='login_success' THEN user_id END) as login,
		        COUNT(CASE WHEN event_type='query' THEN 1 END) as query,
		        COUNT(DISTINCT CASE WHEN event_type='query' THEN user_id END) as dau
		 FROM events WHERE ts >= $1 AND ts < $2
		 GROUP BY d ORDER BY d`, from, to)
	if err != nil {
		http.Error(w, "Query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var items []DailyItem
	for rows.Next() {
		var item DailyItem
		var d time.Time
		if err := rows.Scan(&d, &item.Install, &item.Login, &item.Query, &item.DAU); err != nil {
			continue
		}
		item.Date = d.Format("2006-01-02")
		items = append(items, item)
	}
	if items == nil {
		items = []DailyItem{}
	}
	writeJSON(w, items)
}

// TopDocItem Top 文档单项
type TopDocItem struct {
	DocName string `json:"doc_name"`
	Count   int64  `json:"count"`
	AvgScore float64 `json:"avg_score"`
}

// HandleTopDocs GET /dashboard/top-docs?from=&to=&limit=10
// 返回命中频次最高的文档
func (app *App) HandleTopDocs(w http.ResponseWriter, r *http.Request) {
	from, to := parseTimeRange(r)
	limit := parseIntDefault(r, "limit", 10)
	ctx := r.Context()

	rows, err := app.store.pool.Query(ctx,
		`SELECT doc_name, COUNT(*) as cnt, COALESCE(AVG(score), 0) as avg_score
		 FROM events WHERE event_type='query' AND doc_name != '' AND ts >= $1 AND ts < $2
		 GROUP BY doc_name ORDER BY cnt DESC LIMIT $3`, from, to, limit)
	if err != nil {
		http.Error(w, "Query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var items []TopDocItem
	for rows.Next() {
		var item TopDocItem
		if err := rows.Scan(&item.DocName, &item.Count, &item.AvgScore); err != nil {
			continue
		}
		items = append(items, item)
	}
	if items == nil {
		items = []TopDocItem{}
	}
	writeJSON(w, items)
}

// LowScoreItem 低分问答单项
type LowScoreItem struct {
	UserID    string  `json:"user_id"`
	Query     string  `json:"query"`
	Score     float64 `json:"score"`
	DocName   string  `json:"doc_name"`
	TS        int64   `json:"ts"`
}

// HandleLowScore GET /dashboard/low-score?from=&to=&limit=20
// 返回低分问答列表（score < 0.3），供人工补充知识库
func (app *App) HandleLowScore(w http.ResponseWriter, r *http.Request) {
	from, to := parseTimeRange(r)
	limit := parseIntDefault(r, "limit", 20)
	ctx := r.Context()

	rows, err := app.store.pool.Query(ctx,
		`SELECT user_id, query_text, score, doc_name, ts
		 FROM events WHERE event_type='query' AND score < 0.3 AND ts >= $1 AND ts < $2
		 ORDER BY ts DESC LIMIT $3`, from, to, limit)
	if err != nil {
		http.Error(w, "Query failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var items []LowScoreItem
	for rows.Next() {
		var item LowScoreItem
		if err := rows.Scan(&item.UserID, &item.Query, &item.Score, &item.DocName, &item.TS); err != nil {
			continue
		}
		items = append(items, item)
	}
	if items == nil {
		items = []LowScoreItem{}
	}
	writeJSON(w, items)
}

// writeJSON 写入 JSON 响应
func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// parseTimeRange 解析 from/to 查询参数，默认返回最近 7 天
func parseTimeRange(r *http.Request) (int64, int64) {
	fromStr := r.URL.Query().Get("from")
	toStr := r.URL.Query().Get("to")

	now := time.Now()
	to := now
	from := now.AddDate(0, 0, -7)

	if fromStr != "" {
		if t, err := time.ParseInLocation("2006-01-02", fromStr, time.Local); err == nil {
			from = t
		}
	}
	if toStr != "" {
		if t, err := time.ParseInLocation("2006-01-02", toStr, time.Local); err == nil {
			to = t.AddDate(0, 0, 1) // to 含当天
		}
	}
	return from.UnixMilli(), to.UnixMilli()
}

// parseIntDefault 解析整数参数，带默认值
func parseIntDefault(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
