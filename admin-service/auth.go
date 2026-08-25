package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// 飞书 OAuth 端点
const (
	larkAuthorizeURL  = "https://open.feishu.cn/open-apis/authen/v1/authorize"
	larkTokenURL      = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
	larkUserInfoURL   = "https://open.feishu.cn/open-apis/authen/v1/user_info"
	larkRefreshURL    = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
	sessionCookieName = "admin_session"
	stateCookieName   = "oauth_state"
	sessionTTL        = 7 * 24 * time.Hour
)

// Session 内存会话
type Session struct {
	// mu 保护 token 相关字段（AccessToken/RefreshToken/TokenExpireAt/refreshing），
	// 这些字段会被后台 refreshToken goroutine 并发读写；UserID/Name/ExpireAt
	// 创建后不变，无需加锁
	mu            sync.Mutex
	UserID        string
	Name          string
	AccessToken   string
	RefreshToken  string
	TokenExpireAt time.Time
	ExpireAt      time.Time
	refreshing    bool // 是否有刷新 goroutine 进行中，防止并发重复刷新
}

// SessionStore 内存 session 存储（单机够用，重启失效需重新登录）
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewSessionStore() *SessionStore {
	return &SessionStore{sessions: make(map[string]*Session)}
}

// Set 写入 session
func (s *SessionStore) Set(sid string, sess *Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sid] = sess
}

// Get 读取并校验有效期
func (s *SessionStore) Get(sid string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[sid]
	if !ok || time.Now().After(sess.ExpireAt) {
		return nil
	}
	return sess
}

// Delete 删除 session
func (s *SessionStore) Delete(sid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, sid)
}

// handleLogin 跳转飞书授权页
func (app *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := randHex(16)
	if err != nil {
		log.Printf("生成 OAuth state 失败: %v", err)
		http.Error(w, "failed to generate state", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   600,
	})
	u := larkAuthorizeURL + "?app_id=" + app.cfg.LarkAppID +
		"&redirect_uri=" + url.QueryEscape(app.cfg.LarkRedirectURL) +
		"&response_type=code&state=" + state
	http.Redirect(w, r, u, http.StatusFound)
}

// handleCallback 接收 code，换取 token 与用户信息，写入 session
func (app *App) handleCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		http.Error(w, "missing code or state", http.StatusBadRequest)
		return
	}

	// 校验 state 与 cookie 一致
	stateCookie, err := r.Cookie(stateCookieName)
	if err != nil || stateCookie.Value != state {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	// 清理 state cookie
	http.SetCookie(w, &http.Cookie{
		Name: stateCookieName, Path: "/", MaxAge: -1,
	})

	// 第一步：code 换 user_access_token
	tokenReq, _ := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     app.cfg.LarkAppID,
		"client_secret": app.cfg.LarkAppSecret,
		"code":          code,
		"redirect_uri":  app.cfg.LarkRedirectURL,
	})
	tr, err := doJSON(larkTokenURL, tokenReq)
	if err != nil {
		log.Printf("飞书 token 换取失败: %v", err)
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	if codeVal, ok := tr["code"].(float64); ok && codeVal != 0 {
		msg, _ := tr["error_description"].(string)
		log.Printf("飞书 token 换取错误: %v %s", codeVal, msg)
		http.Error(w, "token exchange failed: "+msg, http.StatusBadGateway)
		return
	}
	accessToken, _ := tr["access_token"].(string)
	refreshToken, _ := tr["refresh_token"].(string)
	expiresIn, _ := tr["expires_in"].(float64)
	if accessToken == "" {
		http.Error(w, "empty access_token", http.StatusBadGateway)
		return
	}

	// 第二步：token 换 userinfo
	ui, err := getUserInfo(accessToken)
	if err != nil {
		log.Printf("飞书 userinfo 获取失败: %v", err)
		http.Error(w, "get user info failed", http.StatusBadGateway)
		return
	}
	userID, _ := ui["user_id"].(string)
	name, _ := ui["name"].(string)

	// 白名单校验（可选）
	if app.cfg.AllowLarkUsers != "" && !containsUser(app.cfg.AllowLarkUsers, userID) {
		http.Error(w, "用户不在白名单内", http.StatusForbidden)
		return
	}

	// 第三步：生成 session
	sid, err := randHex(32)
	if err != nil {
		log.Printf("生成 session id 失败: %v", err)
		http.Error(w, "failed to generate session", http.StatusInternalServerError)
		return
	}
	now := time.Now()
	app.sessions.Set(sid, &Session{
		UserID:        userID,
		Name:          name,
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		TokenExpireAt: now.Add(time.Duration(expiresIn) * time.Second),
		ExpireAt:      now.Add(sessionTTL),
	})
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sid,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	log.Printf("飞书 SSO 登录成功: user_id=%s name=%s", userID, name)
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleLogout 清除 session 并跳转登录
func (app *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil {
		app.sessions.Delete(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Path: "/", MaxAge: -1,
	})
	http.Redirect(w, r, "/auth/login", http.StatusFound)
}

// handleMe 返回当前登录用户信息
func (app *App) handleMe(w http.ResponseWriter, r *http.Request) {
	sess := app.sessionFromRequest(r)
	if sess == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, map[string]string{
		"user_id": sess.UserID,
		"name":    sess.Name,
	})
}

// SessionAuth Session 中间件：校验 cookie，未登录跳转 SSO
func (app *App) SessionAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess := app.sessionFromRequest(r)
		if sess == nil {
			// 对 API 请求返回 401，对页面请求跳转登录
			if strings.HasPrefix(r.URL.Path, "/dashboard/") {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}
		// 异步刷新 token（临近过期时）；tryRefresh 原子判定并去重，
		// 避免并发请求重复触发刷新（飞书 refresh_token 一次性轮换，并发会互相失效）
		if app.tryRefresh(sess) {
			go app.refreshToken(sess)
		}
		next.ServeHTTP(w, r)
	})
}

// sessionFromRequest 从请求中解析 session
func (app *App) sessionFromRequest(r *http.Request) *Session {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return nil
	}
	return app.sessions.Get(c.Value)
}

// tryRefresh 原子判定是否需要刷新：临近过期（10min 内）且当前无刷新进行中。
// 返回 true 时已置 refreshing 标志，调用方必须执行 refreshToken（其负责清除标志）
func (app *App) tryRefresh(sess *Session) bool {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.refreshing || sess.RefreshToken == "" || time.Until(sess.TokenExpireAt) >= 10*time.Minute {
		return false
	}
	sess.refreshing = true
	return true
}

// refreshToken 后台刷新 user_access_token
// HTTP 调用不持锁（最长 10s，持锁会阻塞所有读该 session 的请求）
func (app *App) refreshToken(sess *Session) {
	sess.mu.Lock()
	rt := sess.RefreshToken
	sess.mu.Unlock()

	body, _ := json.Marshal(map[string]string{
		"grant_type":    "refresh_token",
		"client_id":     app.cfg.LarkAppID,
		"client_secret": app.cfg.LarkAppSecret,
		"refresh_token": rt,
	})
	tr, err := doJSON(larkRefreshURL, body)

	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.refreshing = false
	if err != nil {
		log.Printf("token 刷新失败: %v", err)
		return
	}
	if codeVal, ok := tr["code"].(float64); ok && codeVal != 0 {
		log.Printf("token 刷新错误: %v", codeVal)
		return
	}
	sess.AccessToken, _ = tr["access_token"].(string)
	sess.RefreshToken, _ = tr["refresh_token"].(string)
	if expiresIn, ok := tr["expires_in"].(float64); ok {
		sess.TokenExpireAt = time.Now().Add(time.Duration(expiresIn) * time.Second)
	}
	log.Printf("token 刷新成功: user_id=%s", sess.UserID)
}

// authHTTPClient 飞书 OAuth 接口专用 client，带超时防止上游卡死导致
// 请求链路挂起或后台刷新 goroutine 无限堆积
var authHTTPClient = &http.Client{Timeout: 10 * time.Second}

// doJSON 发送 JSON POST 请求并解析响应
func doJSON(u string, body []byte) (map[string]interface{}, error) {
	resp, err := authHTTPClient.Post(u, "application/json; charset=utf-8", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// getUserInfo 调用飞书 userinfo 接口
func getUserInfo(accessToken string) (map[string]interface{}, error) {
	req, err := http.NewRequest("GET", larkUserInfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := authHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var result struct {
		Code int                    `json:"code"`
		Data map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	if result.Code != 0 {
		return nil, log.Output(2, "userinfo code: "+itoa(result.Code))
	}
	return result.Data, nil
}

// randHex 生成随机 hex 字符串
func randHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// containsUser 检查白名单（逗号分隔）
func containsUser(allowlist, uid string) bool {
	for _, u := range strings.Split(allowlist, ",") {
		if strings.TrimSpace(u) == uid {
			return true
		}
	}
	return false
}

// itoa 简易整型转字符串
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
