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

var KnowledgeBaseDomain = "api-knowledgebase.mlp.cn-beijing.volces.com"          // 知识库域名
var ServiceChatPath = "/api/knowledge/service/chat"                              // 支持知识服务的知识库检索接口
var APIKey = "JDEAQ7QJVARQ0RVDR34MW78DWRJG5K9VZNK2WHJN2JQX787KHTA060R30DHP6RV3E" // 用于知识服务鉴权的apikey
var ServiceResourceID = "kb-service-39d7c93c630152d"                             // 您在平台上创建的知识服务ID

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

// KnowledgeServiceChat 知识服务-非流式返回(检索类型的知识服务或者生成类型的知识服务非流式使用该函数)
func KnowledgeServiceChat(serviceChatReq *ServiceChatRequest) error {
	serviceChatReqBytes, _ := json.Marshal(serviceChatReq)
	req := PrepareRequest("POST", ServiceChatPath, serviceChatReqBytes)
	client := &http.Client{Timeout: 600 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("请求失败: %s\n", err.Error())
		return err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var serviceChatResp *ServiceChatResponse
	err = json.Unmarshal(body, &serviceChatResp)
	if err != nil {
		fmt.Printf("响应解析失败: %s, 原始返回: %s\n", err.Error(), string(body))
		return err
	}

	// 只打印相似度最高的一条切片
	if serviceChatResp.Data == nil || len(serviceChatResp.Data.ResultList) == 0 {
		fmt.Println("未检索到相关信息")
		return nil
	}
	var best *CollectionSearchResponseItem
	bestScore := -1.0
	for i := range serviceChatResp.Data.ResultList {
		item := serviceChatResp.Data.ResultList[i]
		// 优先使用 rerank 得分，若为 0 则退回向量得分
		s := item.RerankScore
		if s == 0 {
			s = item.Score
		}
		if s > bestScore {
			bestScore = s
			best = item
		}
	}
	fmt.Printf("共检索到 %d 条结果，展示相似度最高的一条:\n", serviceChatResp.Data.Count)
	fmt.Printf("文档名称: %s\n", best.DocInfo.DocName)
	fmt.Printf("切片标题: %s\n", best.ChunkTitle)
	fmt.Printf("相似度得分: %.4f (rerank: %.4f)\n", best.Score, best.RerankScore)
	fmt.Printf("内容:\n%s\n", best.Content)
	if best.MdContent != "" {
		fmt.Printf("Markdown内容:\n%s\n", best.MdContent)
	}
	return nil
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

func main() {
	reader := bufio.NewReader(os.Stdin)
	fmt.Println("知识库问答服务已启动，输入问题开始问答（输入 exit 或 quit 退出）")
	for {
		fmt.Print("\n请输入您的问题: ")
		query, err := reader.ReadString('\n')
		if err != nil {
			fmt.Printf("读取输入失败: %s\n", err.Error())
			return
		}
		query = strings.TrimSpace(query)
		if query == "" {
			continue
		}
		// 退出指令
		if query == "exit" || query == "quit" {
			fmt.Println("已退出问答服务")
			return
		}

		// 以下两个函数根据需要二选一
		//纯检索类型的知识服务或者生成类型知识服务非流式返回使用该函数
		if err := KnowledgeServiceChat(GenerateServiceChatReq(false, query)); err != nil {
			fmt.Printf("查询失败: %s\n", err.Error())
		}
		//生成类型的知识服务流式返回 使用该函数
		//KnowledgeServiceChatStream(GenerateServiceChatReq(true, query))
	}
}
