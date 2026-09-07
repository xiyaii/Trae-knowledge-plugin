package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// notifyHTTPClient 通知专用 HTTP 客户端（项目惯例：禁止无超时 DefaultClient）
var notifyHTTPClient = &http.Client{Timeout: 10 * time.Second}

// StartFeedbackNotifier 分钟级 tick 检查是否到发送时刻。
// 不用 sleep 到固定时刻：发送时间存 DB 可在看板在线调整，tick 方案最迟 1 分钟生效。
func (app *App) StartFeedbackNotifier() {
	for {
		now := time.Now()
		next := now.Truncate(time.Minute).Add(time.Minute)
		time.Sleep(time.Until(next))
		app.notifyCheck()
	}
}

// notifyCheck 发送判定：启用 + 星期匹配 + 到达时刻（含 5 分钟重试窗口）+ 当日未发送。
// 当日已发送标记仅在成功后写入，失败后下一分钟 tick 自动重试
func (app *App) notifyCheck() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("feedback notifier panic: %v", r)
		}
	}()

	cfg, err := app.store.GetNotifyConfig()
	if err != nil {
		log.Printf("notifier 读取配置失败: %v", err)
		return
	}
	if !cfg.Enabled || cfg.WebhookURL == "" {
		return
	}
	now := time.Now()
	if !matchWeekday(cfg.NotifyWeekdays, now) {
		return
	}
	notifyAt, err := time.ParseInLocation("15:04", cfg.NotifyTime, time.Local)
	if err != nil {
		return
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), notifyAt.Hour(), notifyAt.Minute(), 0, 0, time.Local)
	if now.Before(today) || now.Sub(today) > 5*time.Minute {
		return
	}
	if cfg.LastSentDate == now.Format("2006-01-02") {
		return
	}
	if err := app.sendFeedbackDigest(cfg); err != nil {
		log.Printf("notifier 发送失败: %v", err)
		return
	}
	if err := app.store.MarkNotifySent(now.Format("2006-01-02")); err != nil {
		log.Printf("notifier 记录发送日期失败: %v", err)
	}
}

// matchWeekday 判断 t 是否在配置的发送星期内。
// weekdays 为逗号分隔的 1-7（周一=1 ... 周日=7），空串不匹配任何一天（前端限制至少选一天）
func matchWeekday(weekdays string, t time.Time) bool {
	wd := (int(t.Weekday())+6)%7 + 1 // Go: Sunday=0 → 转为 周一=1...周日=7
	for _, s := range strings.Split(weekdays, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n == wd {
			return true
		}
	}
	return false
}

// sendFeedbackDigest 统计待处理 badcase 并推送飞书。0 条也发送（周报场景兼作存活心跳）
func (app *App) sendFeedbackDigest(cfg *NotifyConfig) error {
	count, err := app.store.CountPendingFeedback()
	if err != nil {
		return fmt.Errorf("统计待处理反馈失败: %w", err)
	}
	var sb strings.Builder
	for _, u := range strings.Split(cfg.AtUsers, ",") {
		if id := strings.TrimSpace(strings.SplitN(u, "|", 2)[0]); id != "" {
			sb.WriteString(`<at user_id="` + id + `"></at> `)
		}
	}
	sb.WriteString("\n【Trae 知识问答】待处理点踩 badcase：" + strconv.FormatInt(count, 10) + " 条")
	if cfg.DashboardURL != "" {
		sb.WriteString("\n处理入口 → " + cfg.DashboardURL)
	}
	return postLarkWebhook(cfg.WebhookURL, cfg.WebhookSecret, sb.String())
}

// postLarkWebhook 发送 text 消息到飞书自定义机器人，secret 非空时启用签名校验
func postLarkWebhook(webhook, secret, text string) error {
	msg := map[string]interface{}{"msg_type": "text", "content": map[string]string{"text": text}}
	if secret != "" {
		ts, sign, err := signWebhook(secret)
		if err != nil {
			return err
		}
		msg["timestamp"] = ts
		msg["sign"] = sign
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	resp, err := notifyHTTPClient.Post(webhook, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var r struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return fmt.Errorf("解析飞书响应失败: %w", err)
	}
	if r.Code != 0 {
		return fmt.Errorf("飞书返回 code=%d msg=%s", r.Code, r.Msg)
	}
	return nil
}

// signWebhook 飞书自定义机器人签名：
// 以 timestamp+"\n"+secret 作为 key，对空字符串做 HmacSHA256 后 base64
func signWebhook(secret string) (ts, sign string, err error) {
	ts = strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(ts+"\n"+secret))
	sign = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return ts, sign, nil
}

// HandleNotifyConfig GET/PUT /dashboard/notify/config
// GET 返回配置回填表单；PUT 保存（last_sent_date 由服务端管理，不随保存覆盖）
func (app *App) HandleNotifyConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, err := app.store.GetNotifyConfig()
		if err != nil {
			log.Printf("读取通知配置失败: %v", err)
			http.Error(w, "Internal Error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, cfg)
	case http.MethodPut:
		// CSRF 轻量防护：仅接受 JSON（与 HandleReviewFeedback 同策略）
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			http.Error(w, "Unsupported Media Type", http.StatusUnsupportedMediaType)
			return
		}
		var body NotifyConfig
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "Bad Request: "+err.Error(), http.StatusBadRequest)
			return
		}
		if body.NotifyTime == "" {
			body.NotifyTime = "10:00"
		}
		if _, err := time.Parse("15:04", body.NotifyTime); err != nil {
			http.Error(w, "Bad Request: notify_time 须为 HH:MM", http.StatusBadRequest)
			return
		}
		if err := app.store.SaveNotifyConfig(&body); err != nil {
			log.Printf("保存通知配置失败: %v", err)
			http.Error(w, "Internal Error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
	}
}

// HandleNotifyTest POST /dashboard/notify/test
// 立即发送一条真实通知（无视 enabled/星期/时刻/当日已发送），用于上线验证链路
func (app *App) HandleNotifyTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	// CSRF 轻量防护：仅接受 JSON（与 HandleReviewFeedback 同策略，跨站表单无法携带此 Content-Type）
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		http.Error(w, "Unsupported Media Type", http.StatusUnsupportedMediaType)
		return
	}
	cfg, err := app.store.GetNotifyConfig()
	if err != nil {
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}
	if cfg.WebhookURL == "" {
		http.Error(w, "Bad Request: webhook 未配置", http.StatusBadRequest)
		return
	}
	if err := app.sendFeedbackDigest(cfg); err != nil {
		log.Printf("notify test 发送失败: %v", err)
		http.Error(w, "发送失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}
