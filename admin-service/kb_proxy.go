package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// ===================== 火山引擎知识库 API 类型定义 =====================
// 从 go-backend/TraeCN_tob_knowledge.go 搬移，用于服务端直接调用火山引擎

var kbDomain = "api-knowledgebase.mlp.cn-beijing.volces.com"
var kbServiceChatPath = "/api/knowledge/service/chat"
var kbServiceResourceID = "kb-service-8f088a75ce8ab429"

// kbHTTPClient 全局复用连接池，避免每次请求重新建立 TCP 连接
// - MaxIdleConnsPerHost: 10 对单 host 足够，超过则新建连接
// - IdleConnTimeout: 90s（默认值），空闲超时后关闭连接
// - 整体超时 55s 略短于 JS 端 60s，避免孤儿请求
var kbHTTPClient = &http.Client{
	Timeout: 55 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        20,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
	},
}

type kbServiceChatRequest struct {
	ServiceResourceID string           `json:"service_resource_id,omitempty"`
	Stream            bool             `json:"stream"`
	Messages          []kbMessageParam `json:"messages"`
}

type kbMessageParam struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type kbServiceChatResponse struct {
	RequestID string                        `json:"request_id,omitempty"`
	Code      int64                         `json:"code"`
	Message   string                        `json:"message,omitempty"`
	Data      *kbCollectionChatResponseData `json:"data,omitempty"`
}

type kbCollectionChatResponseData struct {
	Count      int32                  `json:"count"`
	ResultList []kbSearchResponseItem `json:"result_list,omitempty"`
}

type kbSearchResponseItem struct {
	Content   string              `json:"content"`
	MdContent string              `json:"md_content,omitempty"`
	Score     float64             `json:"score"`
	DocInfo   kbSearchItemDocInfo `json:"doc_info,omitempty"`
}

type kbSearchItemDocInfo struct {
	DocName string `json:"doc_name"`
}

// ===================== /kb/chat 代理接口 =====================

// KBChatRequest 插件 go-backend 发来的代理请求
type KBChatRequest struct {
	Query   string           `json:"query"`
	History []kbMessageParam `json:"history,omitempty"`
}

// HandleKBChat POST /kb/chat
// 接收插件 go-backend 的知识库检索请求，使用服务端 APIKey 调用火山引擎
// 鉴权：X-Track-Token（复用埋点 token，与 go-backend 编译期注入值一致）
func (app *App) HandleKBChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Token 鉴权（复用 trackToken）
	token := r.Header.Get("X-Track-Token")
	if token == "" || token != app.cfg.TrackToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// 解析请求
	var req KBChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad Request: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		http.Error(w, "Bad Request: query is required", http.StatusBadRequest)
		return
	}

	// 构造火山引擎知识库请求
	// 安全：APIKey 经 Bearer 头传输，必须走 HTTPS，防止链路窃听
	chatReq := kbServiceChatRequest{
		ServiceResourceID: kbServiceResourceID,
		Stream:            false,
		Messages: []kbMessageParam{
			{Role: "user", Content: req.Query},
		},
	}
	// 多轮对话历史拼接（history + 当前 query）
	if len(req.History) > 0 {
		chatReq.Messages = append(req.History, chatReq.Messages...)
	}

	// 调用火山引擎知识库 API
	chatResp, err := callKnowledgeBase(&chatReq, app.cfg.KBApiKey)
	if err != nil {
		// 详细错误（含上游状态码/响应体）仅记日志，客户端只收脱敏文案，避免信息泄露
		log.Printf("[kb_proxy] 知识库调用失败: %v", err)
		http.Error(w, "Knowledge base service error", http.StatusBadGateway)
		return
	}

	// 透传原始响应
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(chatResp)
}

// callKnowledgeBase 调用火山引擎知识库 API
func callKnowledgeBase(chatReq *kbServiceChatRequest, apiKey string) (*kbServiceChatResponse, error) {
	reqBytes, _ := json.Marshal(chatReq)

	url := fmt.Sprintf("https://%s%s", kbDomain, kbServiceChatPath)
	req, err := http.NewRequest("POST", url, bytes.NewReader(reqBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	// Host 由 URL 自动推导，无需显式设置
	req.Header.Set("Authorization", "Bearer "+apiKey)

	// 使用全局 kbHTTPClient 复用 TCP 连接，避免每次请求重新握手
	resp, err := kbHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("火山引擎返回 status=%d body=%s", resp.StatusCode, string(body))
	}

	var result kbServiceChatResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("响应解析失败: %s, 原始返回: %s", err.Error(), string(body))
	}
	return &result, nil
}
