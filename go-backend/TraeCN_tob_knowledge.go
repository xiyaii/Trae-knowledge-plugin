package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

var KnowledgeBaseDomain = "api-knowledgebase.mlp.cn-beijing.volces.com" // 知识库域名
var ServiceChatPath = "/api/knowledge/service/chat"                     // 支持知识服务的知识库检索接口
var APIKey = ""                                                         // 编译期通过 -ldflags "-X main.APIKey=xxx" 注入；运行时可用 TRAE_KB_API_KEY 覆盖
var ServiceResourceID = "kb-service-39d7c93c630152d"                    // 您在平台上创建的知识服务ID

// builtInAPIKey 由编译期 ldflags 注入，不对外暴露到 JS 层
var builtInAPIKey = ""

// LoadConfig 加载配置：优先环境变量（开发调试），其次编译期内置值
func LoadConfig() error {
	envKey := os.Getenv("TRAE_KB_API_KEY")
	if envKey != "" {
		APIKey = envKey
	} else if builtInAPIKey != "" {
		APIKey = builtInAPIKey
	}
	if APIKey == "" {
		return fmt.Errorf("APIKey 未配置：请设置环境变量 TRAE_KB_API_KEY 或在编译时通过 -ldflags 注入")
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

func PrepareRequest(method string, path string, body []byte) *http.Request {
	u := url.URL{
		Scheme: "http",
		Host:   KnowledgeBaseDomain,
		Path:   path,
	}
	req, _ := http.NewRequest(strings.ToUpper(method), u.String(), bytes.NewReader(body))
	req.Header.Add("Accept", "application/json")
	req.Header.Add("Content-Type", "application/json")
	req.Header.Add("Host", KnowledgeBaseDomain)
	req.Header.Add("Authorization", "Bearer "+APIKey)
	return req
}

func GenerateServiceChatReq(stream bool, query string) *ServiceChatRequest {
	return &ServiceChatRequest{
		ServiceResourceID: ServiceResourceID,
		Stream:            stream,
		Messages: []MessageParam{
			// 当query为纯文本时，user的content为query文本
			{
				Role:    "user",
				Content: query,
			},
			// 当query包含图片时，user的content为list结构
			//{
			// Role:    "user",
			// Content: []map[string]interface{}{
			//    {
			//       "text": query,
			//       "type": "text",
			//    },
			//    {
			//       "image_url": map[string]string{
			//          "url": "请传入可访问的图片URL或者Base64编码",
			//       },
			//       "type": "image_url",
			//    },
			// },
			//},
		},
		//QueryParam: QueryParamInfo{},
	}
}

// KnowledgeServiceChat 知识服务-非流式返回，返回完整响应供上层使用（不打印）
func KnowledgeServiceChat(serviceChatReq *ServiceChatRequest) (*ServiceChatResponse, error) {
	serviceChatReqBytes, _ := json.Marshal(serviceChatReq)
	req := PrepareRequest("POST", ServiceChatPath, serviceChatReqBytes)
	client := &http.Client{Timeout: 600 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
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

// KnowledgeServiceChatStream 生成类型知识服务-流式返回（生成类型的知识服务流式返回使用该函数）
func KnowledgeServiceChatStream(serviceChatReq *ServiceChatRequest) (err error) {
	chatCompletionReqParamsBytes, _ := json.Marshal(serviceChatReq)
	request := PrepareRequest("POST", ServiceChatPath, chatCompletionReqParamsBytes)
	client := &http.Client{
		Timeout: time.Second * 600,
	}
	request.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(request)
	if err != nil {
		fmt.Printf("请求失败: %s\n", err.Error())
		return err
	}
	defer resp.Body.Close()
	// 读取流式返回
	scanner := bufio.NewScanner(resp.Body)
	// 指定分隔符函数
	scanner.Split(scanDoubleCRLF)

	var answerBuilder strings.Builder
	var usage TotalTokenUsage

	buf := make([]byte, 0, 150*1024)
	scanner.Buffer(buf, 1500*1024) // 可以按需调整scanner的大小

	// 读取数据
	for scanner.Scan() {
		streamLine := scanner.Text()
		fmt.Println(streamLine)
		if len(streamLine) < 5 {
			continue
		}
		streamJson := streamLine[5:]
		var serviceChatResponse ServiceChatResponse
		err := json.Unmarshal([]byte(streamJson), &serviceChatResponse)
		if err != nil {
			fmt.Printf("请求失败: %s\n", err.Error())
			return err
		}
		if serviceChatResponse.Data.TokenUsage != nil {
			usage = *serviceChatResponse.Data.TokenUsage
		}
		if serviceChatResponse.Data.End {
			fmt.Println("流式输出返回结束")
			break
		}
		answerBuilder.WriteString(serviceChatResponse.Data.GenerateAnswer)
	}

	if err := scanner.Err(); err != nil {
		fmt.Printf("请求失败: %s\n", err.Error())
		return err
	}
	usageStr, _ := json.Marshal(usage)
	fmt.Printf("本次请求Token使用情况: %s\n", usageStr)
	fmt.Printf("LLM回答: %s\n", answerBuilder.String())
	return nil
}

// ===================== JSON Lines 协议层 =====================
// 扩展端（VS Code Extension）通过子进程方式启动本程序，
// 经 stdin 写入请求（每行一个 JSON），经 stdout 输出响应（每行一个 JSON）。
// APIKey 由扩展端通过环境变量 TRAE_KB_API_KEY 注入，不进入代码、不进 git。

// KBRequest 扩展端发来的请求
type KBRequest struct {
	ID      string         `json:"id"`              // 请求 ID，用于多路复用匹配
	Type    string         `json:"type"`            // "query"
	Query   string         `json:"query"`           // 用户问题
	Stream  bool           `json:"stream"`          // 是否流式（暂未启用，预留）
	History []MessageParam `json:"history"`         // 多轮对话历史
	Token   string         `json:"token,omitempty"` // 用户登录态（预留，暂不校验）
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

// VerifyAuth 预留：校验用户登录态/企业版订阅
// TODO: 待确认 Trae 企业版 OpenAPI 鉴权方式后实现
// 返回值: true=放行, false=拒绝
func VerifyAuth(token string) bool {
	// 当前阶段暂不校验，直接放行
	// 后续接入 Trae 企业版鉴权：
	// 1. 用 token 调用 Trae OpenAPI 校验订阅状态
	// 2. 校验通过返回 true，否则 false
	return true
}

// emitResponse 输出一行 JSON 响应到 stdout
func emitResponse(resp KBResponse) {
	bytes, _ := json.Marshal(resp)
	fmt.Println(string(bytes))
}

// handleRequest 处理单个请求
func handleRequest(req KBRequest) {
	// 预留：鉴权校验
	if !VerifyAuth(req.Token) {
		emitResponse(KBResponse{
			ID:    req.ID,
			Type:  "error",
			Error: "登录态校验失败：未购买 Trae 企业版或登录已失效",
		})
		return
	}

	// 调用知识库
	chatReq := GenerateServiceChatReq(false, req.Query)
	// 多轮对话历史拼接（history + 当前 query）
	if len(req.History) > 0 {
		chatReq.Messages = append(req.History, chatReq.Messages...)
	}

	chatResp, err := KnowledgeServiceChat(chatReq)
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

	emitResponse(KBResponse{
		ID:   req.ID,
		Type: "result",
		Data: ResultData{
			Count:       int(chatResp.Data.Count),
			DocName:     best.DocInfo.DocName,
			ChunkTitle:  best.ChunkTitle,
			Score:       best.Score,
			RerankScore: best.RerankScore,
			Content:     best.Content,
			MdContent:   best.MdContent,
		},
	})
}

// runServer JSON Lines 协议主循环：从 stdin 读请求，向 stdout 写响应
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
		handleRequest(req)
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
