package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// kbProxyURL 由编译期 ldflags 注入，指向 admin-service 的 /kb/chat 代理接口
// APIKey 不再存在于客户端二进制中，由 admin-service 服务端持有
var kbProxyURL = ""

// trackEndpoint / trackToken 由编译期 ldflags 注入，用于埋点上报到运营服务端
// 未注入（空值）时 reportTrack 静默跳过，不影响主流程
var trackEndpoint = ""
var trackToken = ""

// LoadConfig 加载配置：校验 kbProxyURL 已注入
func LoadConfig() error {
	if kbProxyURL == "" {
		return fmt.Errorf("kbProxyURL 未配置：请在编译时通过 -ldflags -X main.kbProxyURL 注入 admin-service 代理地址")
	}
	return nil
}

type ServiceChatRequest struct {
	ServiceResourceID string         `json:"service_resource_id,omitempty"` //要检索的知识服务ID
	Stream            bool           `json:"stream"`                        // 仅针对生成类型的知识服务生效，默认为流式返回，false则为非流式返回
	Messages          []MessageParam `json:"messages"`                      // 多轮对话信息Message数组，拼接的多轮对话message的role顺序如下：[user, assistant, user...]，最后一个元素需保证是当前轮次提问，角色为user
	QueryParam        QueryParamInfo `json:"query_param,omitempty"`         // 检索附加过滤条件，在创建知识服务时如果您也配置了过滤条件，那么和该附加条件一起生效，逻辑为AND
}

type QueryParamInfo struct {
	DocFilter interface{} `json:"doc_filter"`
}

type MessageParam struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type ServiceChatResponse struct {
	Code    int64                              `json:"code"`
	Message string                             `json:"message,omitempty"`
	Data    *CollectionServiceChatResponseData `json:"data,omitempty"`
}

type CollectionServiceChatResponseData struct {
	CollectionSearchKnowledgeResponseData
	*CollectionChatCompletionResponseData
}

type CollectionSearchKnowledgeResponseData struct {
	Count        int32                           `json:"count"`
	RewriteQuery string                          `json:"rewrite_query,omitempty"`
	TokenUsage   *TotalTokenUsage                `json:"token_usage,omitempty"`
	ResultList   []*CollectionSearchResponseItem `json:"result_list,omitempty"`
}

// 检索接口各个阶段模型调用量详情，详细介绍见官方文档
type TotalTokenUsage struct {
	EmbeddingUsage *ModelTokenUsage `json:"embedding_token_usage,omitempty"`
	RerankUsage    *int64           `json:"rerank_token_usage,omitempty"`
	LLMUsage       *ModelTokenUsage `json:"llm_token_usage,omitempty"`
	RewriteUsage   *ModelTokenUsage `json:"rewrite_token_usage,omitempty"`
}

// 检索接口返回切片的详情，详细介绍见官方文档
type CollectionSearchResponseItem struct {
	Id                  string                              `json:"id"`
	Content             string                              `json:"content"`
	MdContent           string                              `json:"md_content,omitempty"`
	Score               float64                             `json:"score"`
	PointId             string                              `json:"point_id"`
	OriginText          string                              `json:"origin_text,omitempty"`
	OriginalQuestion    string                              `json:"original_question,omitempty"`
	ChunkTitle          string                              `json:"chunk_title,omitempty"`
	ChunkId             int                                 `json:"chunk_id"`
	ProcessTime         int64                               `json:"process_time"`
	RerankScore         float64                             `json:"rerank_score,omitempty"`
	DocInfo             CollectionSearchResponseItemDocInfo `json:"doc_info,omitempty"`
	RecallPosition      int32                               `json:"recall_position"`
	RerankPosition      int32                               `json:"rerank_position,omitempty"`
	ChunkType           string                              `json:"chunk_type,omitempty"`
	ChunkSource         string                              `json:"chunk_source,omitempty"`
	UpdateTime          int64                               `json:"update_time"`
	ChunkAttachmentList []ChunkAttachment                   `json:"chunk_attachment,omitempty"`
	TableChunkFields    []PointTableChunkField              `json:"table_chunk_fields,omitempty"`
	OriginalCoordinate  *ChunkPositions                     `json:"original_coordinate,omitempty"`
}

type CollectionSearchResponseItemDocInfo struct {
	Docid      string `json:"doc_id"`
	DocName    string `json:"doc_name"`
	CreateTime int64  `json:"create_time"`
	DocType    string `json:"doc_type"`
	DocMeta    string `json:"doc_meta,omitempty"`
	Source     string `json:"source"`
	Title      string `json:"title,omitempty"`
}

type ChunkAttachment struct {
	UUID    string `json:"uuid,omitempty"`
	Caption string `json:"caption"`
	Type    string `json:"type"`
	Link    string `json:"link,omitempty"`
}

type PointTableChunkField struct {
	FieldName  string      `json:"field_name"`
	FieldValue interface{} `json:"field_value"`
}

type ChunkPositions struct {
	PageNo []int       `json:"page_no"`
	BBox   [][]float64 `json:"bbox"`
}

type CollectionChatCompletionResponseData struct {
	GenerateAnswer   string  `json:"generated_answer"`
	ReasoningContent string  `json:"reasoning_content,omitempty"`
	Prompt           *string `json:"prompt,omitempty"`
	End              bool    `json:"end,omitempty"`
}

type ModelTokenUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`     // 请求文本的分词数
	CompletionTokens int64 `json:"completion_tokens"` // 生成文本的分词数, 对话模型才有值, 其他模型都是0
	TotalTokens      int64 `json:"total_tokens"`      // PromptTokens + CompletionTokens
}

// scanDoubleCRLF 是一个 bufio.SplitFunc，用于分隔 \r\n\r\n
func scanDoubleCRLF(data []byte, atEOF bool) (advance int, token []byte, err error) {
	// 查找 \r\n\r\n 分隔符
	if i := bytes.Index(data, []byte("\r\n\r\n")); i >= 0 {
		// 返回位置后的分隔符
		return i + 4, data[0:i], nil
	}
	if atEOF && strings.Contains(string(data), "\"end\":true") {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// KBProxyRequest go-backend → admin-service /kb/chat 的请求体
type KBProxyRequest struct {
	Query   string         `json:"query"`
	History []MessageParam `json:"history,omitempty"`
}

// KnowledgeServiceChat 通过 admin-service 代理调用知识库（APIKey 存在于服务端，客户端不持有）
// 返回 admin-service 透传的原始 ServiceChatResponse JSON
func KnowledgeServiceChat(query string, history []MessageParam) (*ServiceChatResponse, error) {
	proxyReq := KBProxyRequest{
		Query:   query,
		History: history,
	}
	proxyReqBytes, _ := json.Marshal(proxyReq)

	req, err := http.NewRequest("POST", kbProxyURL, bytes.NewReader(proxyReqBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// 复用 trackToken 作为 /kb/chat 的鉴权 token
	if trackToken != "" {
		req.Header.Set("X-Track-Token", trackToken)
	}

	// 超时 55s：略短于 JS 端 60s，避免客户端先超时产生孤儿请求
	// 知识库 embedding+rerank 正常 5-15s，55s 足够覆盖异常慢请求
	client := &http.Client{Timeout: 55 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("代理服务返回错误: status=%d, body=%s", resp.StatusCode, string(body))
	}

	var serviceChatResp *ServiceChatResponse
	err = json.Unmarshal(body, &serviceChatResp)
	if err != nil {
		return nil, fmt.Errorf("响应解析失败: %s, 原始返回: %s", err.Error(), string(body))
	}
	return serviceChatResp, nil
}

// SelectBestResult 从检索结果中选出相似度最高的一条（优先 rerank 得分，为 0 时退回向量得分）
func SelectBestResult(resp *ServiceChatResponse) (*CollectionSearchResponseItem, error) {
	if resp == nil || resp.Data == nil || len(resp.Data.ResultList) == 0 {
		return nil, fmt.Errorf("未检索到相关信息")
	}
	var best *CollectionSearchResponseItem
	bestScore := -1.0
	for i := range resp.Data.ResultList {
		item := resp.Data.ResultList[i]
		s := item.RerankScore
		if s == 0 {
			s = item.Score
		}
		if s > bestScore {
			bestScore = s
			best = item
		}
	}
	return best, nil
}

// kbTagPattern 匹配知识库切片元信息标签，如 <KBDirectory>...</KBDirectory>、<KBDocName>...</KBDocName>
var kbTagPattern = regexp.MustCompile(`(?m)^<KB[A-Za-z]+>[^<]*</KB[A-Za-z]+>\s*\n?`)

// CleanContent 清理知识库原始切片内容中的元信息标签和多余空白
// - 移除 <KBDirectory>、<KBDocName> 等标签行
// - 去除首尾空白
func CleanContent(content string) string {
	if content == "" {
		return content
	}
	cleaned := kbTagPattern.ReplaceAllString(content, "")
	return strings.TrimSpace(cleaned)
}

// ===================== JSON Lines 协议层 =====================
// 扩展端（VS Code Extension）通过子进程方式启动本程序，
// 经 stdin 写入请求（每行一个 JSON），经 stdout 输出响应（每行一个 JSON）。
// APIKey 不再存在于客户端，知识库调用通过 admin-service /kb/chat 代理转发。

// KBRequest 扩展端发来的请求
type KBRequest struct {
	ID        string         `json:"id"`                   // 请求 ID，用于多路复用匹配
	Type      string         `json:"type"`                 // "query" | "track"
	Event     string         `json:"event,omitempty"`      // track 事件类型：install | login_success | query
	Query     string         `json:"query,omitempty"`      // 用户问题
	Stream    bool           `json:"stream"`               // 是否流式（暂未启用，预留）
	History   []MessageParam `json:"history"`              // 多轮对话历史
	Token     string         `json:"token,omitempty"`      // 用户登录态（预留，暂不校验）
	UserID    string         `json:"user_id,omitempty"`    // 用户标识（iCubeAuthInfo://usertag）
	MachineID string         `json:"machine_id,omitempty"` // 设备标识（vscode.env.machineId）
	Platform  string         `json:"platform,omitempty"`   // darwin-arm64 / win32-x64
	PluginVer string         `json:"plugin_ver,omitempty"` // 插件版本
}

// KBResponse 返回给扩展端的响应
type KBResponse struct {
	ID    string      `json:"id"`
	Type  string      `json:"type"` // "result" | "error"
	Data  interface{} `json:"data,omitempty"`
	Error string      `json:"error,omitempty"`
}

// ResultData 检索结果数据
type ResultData struct {
	Count       int     `json:"count"`
	DocName     string  `json:"doc_name"`
	ChunkTitle  string  `json:"chunk_title"`
	Score       float64 `json:"score"`
	RerankScore float64 `json:"rerank_score"`
	Content     string  `json:"content"`
	MdContent   string  `json:"md_content,omitempty"`
}

// VerifyAuth 校验用户登录态：读取本地 storage.json 校验 Trae 企业版订阅
// 逻辑与 src/auth.ts 中的 Auth.verify() 完全一致
// 返回值: true=放行, false=拒绝
func VerifyAuth(token string) bool {
	result := VerifyStorage()
	if !result.OK {
		fmt.Fprintf(os.Stderr, "WARN: 鉴权失败: %s\n", result.Reason)
		return false
	}
	return true
}

// emitMu 保护 stdout 并发写入，避免多 goroutine 输出交错
var emitMu sync.Mutex

// emitResponse 输出一行 JSON 响应到 stdout
func emitResponse(resp KBResponse) {
	bytes, _ := json.Marshal(resp)
	emitMu.Lock()
	fmt.Println(string(bytes))
	emitMu.Unlock()
}

// concurrencySem 限制并发请求数，避免无界 goroutine 耗尽资源
// 客户端子进程场景并发量通常 <10，16 足够应对突发流量
var concurrencySem = make(chan struct{}, 16)

// ===================== 埋点上报 =====================

// TrackPayload 上报到运营服务端的 payload
type TrackPayload struct {
	Event     string  `json:"event"`
	UserID    string  `json:"user_id,omitempty"`
	MachineID string  `json:"machine_id,omitempty"`
	MsgID     string  `json:"msg_id,omitempty"`
	Query     string  `json:"query,omitempty"`
	Score     float64 `json:"score,omitempty"`
	DocName   string  `json:"doc_name,omitempty"`
	Platform  string  `json:"platform,omitempty"`
	PluginVer string  `json:"plugin_ver,omitempty"`
	TS        int64   `json:"ts"`
}

// reportTrack 同步上报埋点事件到运营服务端
//   - trackEndpoint 为空时静默跳过
//   - 3s 超时，失败静默，不阻塞知识库问答
//   - 注：原 goroutine 异步方案在 scanner.Scan() 阻塞期间不被调度，
//     导致上报丢失；改为同步调用确保可靠性（实测 <100ms）
func reportTrack(payload TrackPayload) {
	if trackEndpoint == "" {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[track] ERR Marshal: %v\n", err)
		return
	}
	req, err := http.NewRequest("POST", trackEndpoint, bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[track] ERR NewRequest: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if trackToken != "" {
		req.Header.Set("X-Track-Token", trackToken)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[track] ERR Do: %v event=%s msg_id=%s\n", err, payload.Event, payload.MsgID)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "[track] WARN status=%d event=%s msg_id=%s\n", resp.StatusCode, payload.Event, payload.MsgID)
	}
}

// handleRequest 处理单个请求
func handleRequest(req KBRequest) {
	// track 类型：埋点上报，不经过鉴权（install 时用户可能未登录）
	if req.Type == "track" {
		emitResponse(KBResponse{ID: req.ID, Type: "result", Data: map[string]interface{}{"ok": true}})
		if req.Event != "" {
			reportTrack(TrackPayload{
				Event:     req.Event,
				UserID:    req.UserID,
				MachineID: req.MachineID,
				Platform:  req.Platform,
				PluginVer: req.PluginVer,
				TS:        time.Now().UnixMilli(),
			})
		}
		return
	}

	// 预留：鉴权校验
	if !VerifyAuth(req.Token) {
		emitResponse(KBResponse{
			ID:    req.ID,
			Type:  "error",
			Error: "登录态校验失败：未购买 Trae 企业版或登录已失效",
		})
		return
	}

	// 调用知识库（通过 admin-service 代理，APIKey 存在于服务端）
	chatResp, err := KnowledgeServiceChat(req.Query, req.History)
	if err != nil {
		emitResponse(KBResponse{
			ID:    req.ID,
			Type:  "error",
			Error: err.Error(),
		})
		return
	}

	// 选出相似度最高的一条
	best, err := SelectBestResult(chatResp)
	if err != nil {
		emitResponse(KBResponse{
			ID:   req.ID,
			Type: "result",
			Data: ResultData{Count: 0},
		})
		return
	}

	// 相似度阈值校验：score < 0.2 视为完全无关，返回未命中提示
	// 注：火山向量检索得分范围通常 0.2-0.5，0.5 阈值过于严格会误杀有效结果
	// 检索质量主要由火山知识库后台的 embedding/rerank 配置控制，此处仅做兜底过滤
	if best.Score < 0.2 {
		// 先返回结果给用户，再上报埋点（避免埋点阻塞用户响应）
		emitResponse(KBResponse{
			ID:   req.ID,
			Type: "result",
			Data: ResultData{
				Count:   0,
				Score:   best.Score,
				Content: "知识库未检索到相关内容，请寻找Trae技术支持进行确认",
			},
		})
		// 上报 query 事件（低分也记录，便于分析知识库覆盖缺口）
		reportTrack(TrackPayload{
			Event:     "query",
			UserID:    req.UserID,
			MachineID: req.MachineID,
			MsgID:     req.ID,
			Query:     req.Query,
			Score:     best.Score,
			Platform:  req.Platform,
			PluginVer: req.PluginVer,
			TS:        time.Now().UnixMilli(),
		})
		return
	}

	// 先返回结果给用户，再上报埋点
	emitResponse(KBResponse{
		ID:   req.ID,
		Type: "result",
		Data: ResultData{
			Count:       int(chatResp.Data.Count),
			DocName:     best.DocInfo.DocName,
			ChunkTitle:  best.ChunkTitle,
			Score:       best.Score,
			RerankScore: best.RerankScore,
			Content:     CleanContent(best.Content),
			MdContent:   CleanContent(best.MdContent),
		},
	})

	// 上报 query 事件
	reportTrack(TrackPayload{
		Event:     "query",
		UserID:    req.UserID,
		MachineID: req.MachineID,
		MsgID:     req.ID,
		Query:     req.Query,
		Score:     best.Score,
		DocName:   best.DocInfo.DocName,
		Platform:  req.Platform,
		PluginVer: req.PluginVer,
		TS:        time.Now().UnixMilli(),
	})
}

// runServer JSON Lines 协议主循环：从 stdin 读请求，向 stdout 写响应
// 并发处理：每个请求独立 goroutine，由 concurrencySem 限制并发数（16）
// 响应通过 emitMu 互斥写入 stdout，JS 端按 id 匹配 pending，顺序无关
func runServer() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req KBRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			emitResponse(KBResponse{
				Type:  "error",
				Error: "请求解析失败: " + err.Error(),
			})
			continue
		}
		// 并发处理：避免单个慢请求阻塞后续请求
		// 信号量满时阻塞在此，实现背压（backpressure）
		concurrencySem <- struct{}{}
		go func(r KBRequest) {
			defer func() { <-concurrencySem }()
			handleRequest(r)
		}(req)
	}
	return scanner.Err()
}

func main() {
	// 从环境变量加载 APIKey（由扩展端/后端代理注入，不硬编码）
	if err := LoadConfig(); err != nil {
		emitResponse(KBResponse{
			Type:  "error",
			Error: err.Error(),
		})
		os.Exit(1)
	}

	// 启动 JSON Lines 协议主循环
	if err := runServer(); err != nil {
		emitResponse(KBResponse{
			Type:  "error",
			Error: "服务异常: " + err.Error(),
		})
		os.Exit(1)
	}
}
