package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ===================== 火山引擎官方文档兜底（volc-docs skill 服务端集成） =====================
// 能力来源：https://clawhub.ai/jinsun-fiver/skills/volc-docs
// 作用：知识库 score<0.2 / 无结果时，检索火山官方文档（限 Trae 产品），由方舟 LLM 合成回答
// 注：docs-api 实测免鉴权（2026-09），字段名为大写开头（Query/Url/Limit/ServiceCodes）

var docsAPIHost = "docs-api.cn-beijing.volces.com"
var arkChatURL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"

// docsServiceCodes 严格遵循 skill.md：search 固定按产品过滤，仅检索 Trae 相关文档
var docsServiceCodes = []string{"trae"}

// docsHTTPClient 文档 search/fetch 客户端（实测响应 1-3s，8s 超时足够）
var docsHTTPClient = &http.Client{
	Timeout: 8 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
	},
}

// arkHTTPClient 方舟 LLM 合成回答客户端
// 超时预算：本接口最坏 = search(8s) + fetch(8s) + 合成(30s) = 46s
//
//	< WriteTimeout 60s，且 < 插件端 docs 兜底超时 48s，避免客户端先超时产生孤儿 ARK 调用
var arkHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     90 * time.Second,
	},
}

type docsSearchRequest struct {
	Query        string   `json:"Query"`
	Limit        int      `json:"Limit,omitempty"`
	ServiceCodes []string `json:"ServiceCodes,omitempty"`
}

type docsSearchItem struct {
	Title        string   `json:"Title"`
	Url          string   `json:"Url"`
	Content      string   `json:"Content"`
	ServiceCodes []string `json:"ServiceCodes,omitempty"`
}

type docsSearchResponse struct {
	Code    int    `json:"Code,omitempty"`
	Message string `json:"Message,omitempty"`
	Result  struct {
		DocList []docsSearchItem `json:"DocList"`
	} `json:"Result"`
}

type docsFetchRequest struct {
	Url string `json:"Url"`
}

type docsFetchResponse struct {
	Code    int    `json:"Code,omitempty"`
	Message string `json:"Message,omitempty"`
	Result  struct {
		Title   string `json:"Title"`
		Content string `json:"Content"`
	} `json:"Result"`
}

// docURLPattern 从用户 query 中提取火山官方文档链接（skill 决策规则1：带链接时直接 fetch）
var docURLPattern = regexp.MustCompile(`https?://www\.volcengine\.com/docs/\d+/\d+`)

// cleanDocURL 剥离文档链接的 query/fragment 参数
// skill 规则：?lang=zh 等参数需去除后才可请求，展示引用时也使用纯净链接（CleanUrl）
func cleanDocURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// searchDocs 检索火山官方文档（固定 ServiceCodes=trae），按相关性排序返回
func searchDocs(query string, limit int) ([]docsSearchItem, error) {
	body, _ := json.Marshal(docsSearchRequest{
		Query:        query,
		Limit:        limit,
		ServiceCodes: docsServiceCodes,
	})
	req, err := http.NewRequest("POST", fmt.Sprintf("https://%s/api/v1/doc/search", docsAPIHost), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := docsHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("docs search status=%d body=%s", resp.StatusCode, string(raw))
	}

	var parsed docsSearchResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("docs search 解析失败: %w", err)
	}
	if parsed.Code != 0 && parsed.Code != 200 && parsed.Code != 1000 {
		log.Printf("[docs_answer] search 业务码异常 code=%d message=%s", parsed.Code, parsed.Message)
	}
	return parsed.Result.DocList, nil
}

// fetchDoc 获取指定文档的完整正文（URL 需先剥离 query 参数）
func fetchDoc(rawURL string) (string, string, error) {
	body, _ := json.Marshal(docsFetchRequest{Url: cleanDocURL(rawURL)})
	req, err := http.NewRequest("POST", fmt.Sprintf("https://%s/api/v1/doc/fetch", docsAPIHost), bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := docsHTTPClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("docs fetch status=%d body=%s", resp.StatusCode, string(raw))
	}

	var parsed docsFetchResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", "", fmt.Errorf("docs fetch 解析失败: %w", err)
	}
	if parsed.Result.Content == "" {
		return "", "", fmt.Errorf("docs fetch 内容为空 code=%d message=%s", parsed.Code, parsed.Message)
	}
	return parsed.Result.Title, parsed.Result.Content, nil
}

// truncateRunes 按 rune 截断，避免切中多字节字符产生非法 UTF-8
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// docsSystemPrompt 合成回答的系统提示词，严格对齐 volc-docs skill 的结果处理规则：
// 1. 回答末尾必须附上参考来源 [文档标题](纯净URL)
// 2. 最多展示 3 条最相关结果，每条标注来源
// 3. 链接使用 CleanUrl（已剥离 query 参数）
// 另强化两点：禁止内部知识补充（防过期知识污染）、文档无法回答时输出固定降级话术（防弱相关拼凑）
const docsSystemPrompt = `你是火山引擎 Trae 产品的技术支持助手，任务是基于提供的官方文档回答用户问题。

【内容约束】
1. 只使用文档内容回答，禁止使用你自身的知识补充任何细节——你的内部知识可能过时，与文档冲突时一律以文档为准
2. 文档内容无法覆盖用户问题时，明确回答"当前官方文档未覆盖该问题，建议联系 Trae 技术支持确认"，禁止从弱相关的文档中拼凑答案

【格式约束】
3. 使用中文 markdown 回答，直接给出解决方案，优先保留配置项、命令、路径、步骤等原文细节，不写铺垫性内容

【引用约束】
4. 回答末尾附上实际参考的文档链接，格式为 [文档标题](URL)，每条单独一行，最多 3 条；只列真实参考过的文档，未使用的文档不列
5. URL 原样使用文档提供的链接，禁止添加或修改任何 query 参数`

// ===================== /kb/docs-answer 官方文档兜底接口 =====================

type DocsAnswerRequest struct {
	Query string `json:"query"`
}

// DocsAnswerRef 返回给客户端的引用来源（不含 Content，控制响应体大小）
type DocsAnswerRef struct {
	Title string `json:"title"`
	Url   string `json:"url"`
}

type DocsAnswerResponse struct {
	Answer string          `json:"answer"`
	Docs   []DocsAnswerRef `json:"docs,omitempty"`
}

type arkChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type arkChatRequest struct {
	Model    string           `json:"model"`
	Messages []arkChatMessage `json:"messages"`
}

type arkChatResponse struct {
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// HandleDocsAnswer POST /kb/docs-answer
// 知识库 score<0.2 / 无结果时的官方文档兜底，编排严格遵循 volc-docs skill 决策逻辑：
// 1. query 含文档链接 → 直接 fetch 全文回答（skill 决策规则1，无需检索）
// 2. 常规提问 → search（限 Trae 产品），优先使用返回的 Content 回答
// 3. Top1 的 Content 过短（片段不足以回答）→ fetch Top1 全文补充（skill 配合规则3）
// 鉴权与 /kb/chat 一致（X-Track-Token）；文档未命中时返回空 answer，客户端回退固定文案
func (app *App) HandleDocsAnswer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	token := r.Header.Get("X-Track-Token")
	if token == "" || token != app.cfg.TrackToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if app.cfg.ARKApiKey == "" {
		http.Error(w, "Docs fallback not configured", http.StatusNotImplemented)
		return
	}

	var req DocsAnswerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad Request: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Query == "" {
		http.Error(w, "Bad Request: query is required", http.StatusBadRequest)
		return
	}

	start := time.Now()

	// 情形1：query 携带官方文档链接 → 直接 fetch（skill 决策规则1）
	if link := docURLPattern.FindString(req.Query); link != "" {
		title, content, err := fetchDoc(link)
		if err != nil {
			// fetch 失败降级为常规检索，不直接失败
			log.Printf("[docs_answer] query 带链接 fetch 失败（降级 search）: %v", err)
		} else {
			log.Printf("[docs_answer] query=%q mode=fetch url=%s 耗时=%dms", req.Query, cleanDocURL(link), time.Since(start).Milliseconds())
			app.docsAnswerWithLLM(w, req.Query, []docsSearchItem{{Title: title, Url: cleanDocURL(link), Content: content}}, start)
			return
		}
	}

	// 情形2：常规检索（skill 默认返回 5 条，合成时取最相关的 Top3）
	docs, err := searchDocs(req.Query, 5)
	if err != nil {
		log.Printf("[docs_answer] 检索失败: %v", err)
		http.Error(w, "Docs service error", http.StatusBadGateway)
		return
	}
	if len(docs) == 0 {
		// 官方文档也无结果：返回空 answer，客户端回退固定文案
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(DocsAnswerResponse{})
		return
	}

	// 情形3：Top1 Content 过短视为片段，fetch 全文补充（skill 配合规则3：需要完整内容时先 search 再 fetch）
	// 500 rune 阈值：低于此值通常只是目录/摘要片段，不足以独立回答
	if len([]rune(docs[0].Content)) < 500 {
		if title, content, err := fetchDoc(docs[0].Url); err != nil {
			// fetch 失败静默降级：继续用 search 返回的 Content
			log.Printf("[docs_answer] Top1 全文 fetch 失败（降级用片段）: %v", err)
		} else {
			docs[0].Title = title
			docs[0].Content = content
		}
	}

	// 取 Top3 用于合成与引用展示（skill 输出规则2）
	top3 := docs
	if len(top3) > 3 {
		top3 = top3[:3]
	}
	app.docsAnswerWithLLM(w, req.Query, top3, start)
}

// docsAnswerWithLLM 用方舟 LLM 基于文档内容合成回答
func (app *App) docsAnswerWithLLM(w http.ResponseWriter, query string, docs []docsSearchItem, start time.Time) {
	// 拼接文档上下文：search 片段截断 4000 rune / fetch 全文截断 6000 rune，控制 token 成本
	var sb strings.Builder
	refs := make([]DocsAnswerRef, 0, len(docs))
	for i, d := range docs {
		limit := 4000
		if len([]rune(d.Content)) > 4500 {
			limit = 6000 // fetch 全文场景放宽截断
		}
		refs = append(refs, DocsAnswerRef{Title: d.Title, Url: cleanDocURL(d.Url)})
		fmt.Fprintf(&sb, "## 文档%d：%s\nURL：%s\n%s\n\n", i+1, d.Title, cleanDocURL(d.Url), truncateRunes(d.Content, limit))
	}

	arkReq, _ := json.Marshal(arkChatRequest{
		Model: app.cfg.ARKModel,
		Messages: []arkChatMessage{
			{Role: "system", Content: docsSystemPrompt},
			{Role: "user", Content: "官方文档内容：\n" + sb.String() + "\n用户问题：" + query},
		},
	})
	httpReq, err := http.NewRequest("POST", arkChatURL, bytes.NewReader(arkReq))
	if err != nil {
		http.Error(w, "Internal Error", http.StatusInternalServerError)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+app.cfg.ARKApiKey)

	httpResp, err := arkHTTPClient.Do(httpReq)
	if err != nil {
		log.Printf("[docs_answer] 方舟调用失败: %v", err)
		http.Error(w, "LLM service error", http.StatusBadGateway)
		return
	}
	defer httpResp.Body.Close()
	raw, _ := io.ReadAll(httpResp.Body)

	if httpResp.StatusCode != http.StatusOK {
		// 详细错误（含状态码/响应体）仅记日志，客户端只收脱敏文案
		log.Printf("[docs_answer] 方舟返回 status=%d body=%s", httpResp.StatusCode, string(raw))
		http.Error(w, "LLM service error", http.StatusBadGateway)
		return
	}

	var arkResp arkChatResponse
	if err := json.Unmarshal(raw, &arkResp); err != nil {
		log.Printf("[docs_answer] 方舟响应解析失败: %v", err)
		http.Error(w, "LLM service error", http.StatusBadGateway)
		return
	}
	if arkResp.Error != nil || len(arkResp.Choices) == 0 || arkResp.Choices[0].Message.Content == "" {
		msg := "empty choices"
		if arkResp.Error != nil {
			msg = arkResp.Error.Message
		}
		log.Printf("[docs_answer] 方舟无有效回答: %s", msg)
		http.Error(w, "LLM service error", http.StatusBadGateway)
		return
	}

	log.Printf("[docs_answer] query=%q docs=%d 总耗时=%dms", query, len(docs), time.Since(start).Milliseconds())

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(DocsAnswerResponse{
		Answer: arkResp.Choices[0].Message.Content,
		Docs:   refs,
	})
}
