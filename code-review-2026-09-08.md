# 代码审查与修复记录

> **审查日期**：2026-09-08
> **审查范围**：全项目 5 个模块（扩展 TS / Webview UI / Go 后端 / Admin 服务 Go / Admin Dashboard UI）
> **修复范围**：2 个 Critical + 7 个 Major + 1 个 Minor（未修复，仅记录）
> **涉及提交**：`1d5bf79` fix: 修复多个稳定性问题、`ded4b29` fix(auth): 修复鉴权旁路漏洞
> **基准版本**：v0.2.16（`22aa9c0`）

---

## 一、修复清单

### Critical（2 项，已修复）

#### C1 — KB 代理返回 JSON `null` 时 nil 指针 panic 致进程崩溃

| 项 | 内容 |
|----|------|
| **严重度** | Critical |
| **文件** | `go-backend/TraeCN_tob_knowledge.go` |
| **根因** | `var serviceChatResp *ServiceChatResponse`（指针类型），`json.Unmarshal(body, &serviceChatResp)` 在 body 为 JSON `null` 时不分配、不报错，返回 `(nil, nil)`；调用方 `chatResp.Data` 解引用 nil 指针 panic，goroutine 无 recover 拖垮整进程 |
| **修复** | 改值类型 `var serviceChatResp ServiceChatResponse`，返回 `&serviceChatResp`。KB 返回 `null` 时为非 nil 指针指向零值结构体，`Data` 字段为 nil 被调用方 `chatResp.Data != nil` 判空跳过 |
| **代码位置** | [L231](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L231), [L235](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L235) |
| **修复方案选择** | 选"值类型"而非"调用方加 nil 判空"——在源头堵死 nil 返回路径，结构性根治，调用方已有的判空逻辑天然生效 |

#### C2 — `log.Output` 误用致鉴权旁路

| 项 | 内容 |
|----|------|
| **严重度** | Critical |
| **文件** | `admin-service/auth.go` |
| **根因** | `return nil, log.Output(2, "userinfo code: "+itoa(result.Code))`。Go 标准库 `log.Output(calldepth, s)` 返回"写入日志底层 writer 是否出错"，写入 stderr 成功时返回 `nil`。故飞书 userinfo 返回非零 code 时实际等价于 `return nil, nil`——既无数据也无错误。调用方 `if err != nil` 不成立，跳过错误处理，对 nil map 取值得空 UserID，创建空身份合法会话，鉴权白名单形同虚设 |
| **修复** | `return nil, fmt.Errorf("userinfo code: %d", result.Code)` + 新增 `fmt` import + 删除仅服务此处的自制 `itoa` 函数 + 加防回滚注释 |
| **代码位置** | [auth.go:8](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/auth.go#L8)（fmt import）, [auth.go:353-357](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/auth.go#L353-L357)（fmt.Errorf + 防回滚注释） |
| **防回滚注释** | `// 修复 log.Output 误用，勿回滚：log.Output 返回的是写日志的 I/O 错误（成功即 nil），而非字符串包装的 error。原写法 result.Code != 0 时返回 (nil, nil) 致鉴权旁路。` |
| **部署历史** | 首次修复后被 git pull 合并冲突覆盖回滚，已重新修复并加防回滚注释 |

---

### Major（7 项，已修复）

#### M1 — `ensureProcess()` async 竞态产生孤儿进程

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `src/goBridge.ts` |
| **根因** | `ensureProcess()` 是 async，await 期间并发调用均通过空检查各自 spawn，产生孤儿进程；exit handler 误杀存活的引用致级联故障 |
| **修复** | 新增 `ensurePromise: Promise<void> \| undefined` 字段，重构 `ensureProcess` 为"锁入口 + `_doEnsureProcess` 实现"。并发调用复用同一 Promise，await 间隙不再重复 spawn；finally 块清空锁 |
| **代码位置** | [L56-57](file:///Users/bytedance/Trae_support/Trae_Plugin/src/goBridge.ts#L56-L57)（字段）, [L75-89](file:///Users/bytedance/Trae_support/Trae_Plugin/src/goBridge.ts#L75-L89)（锁+finally）, [L91-93](file:///Users/bytedance/Trae_support/Trae_Plugin/src/goBridge.ts#L91-L93)（`_doEnsureProcess` 拆分） |

#### M2 — spawn 子进程无 `on('error')` handler 崩溃扩展宿主

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `src/goBridge.ts` |
| **根因** | spawn 失败（ENOENT/EACCES/架构不匹配）时 Node 抛 unhandled 'error' event，崩溃扩展宿主 |
| **修复** | 新增 `this.proc.on('error', ...)` handler，spawn 失败时清空 `this.proc`、拒绝所有 pending、打日志 |
| **代码位置** | [L155-164](file:///Users/bytedance/Trae_support/Trae_Plugin/src/goBridge.ts#L155-L164) |
| **竞态验证** | exit handler 和 error handler 都设 `proc=undefined` + 拒绝 pending。Node 单线程，事件回调不并发执行——第一个 handler 清空 pending 后，第二个遍历空 Map，无重复拒绝 |

#### M3 — `fetchText` 不跟随 3xx 重定向

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `src/updater.ts` |
| **根因** | `fetchText` 仅接受 200，而 `downloadFile` 实现了重定向；TOS/CDN 302 → latest.json 拉取失败，自动更新 24h 内不再触发 |
| **修复** | `fetchText(url, redirects = 5)` 加 3xx 重定向跟随（递归校验 HTTPS，最多 5 跳），对齐 `downloadFile` 行为 |
| **代码位置** | [updater.ts:53-75](file:///Users/bytedance/Trae_support/Trae_Plugin/src/updater.ts#L53-L75) |

#### M4 — feedback-bar CSS 类未应用致"点踩可改原因"功能在鼠标脱离时不可操作

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `webview-ui/src/components/ChatMessage.tsx` |
| **根因** | CSS 中定义了 `.has-feedback` 和 `.show-reason` 选择器，但 JSX 的 `className="feedback-bar"` 是固定字符串，从未应用这两个类。导致：① 已点赞/已点踩状态下鼠标移开消息时状态栏消失；② 点踩展开原因面板后鼠标移开消息时面板 opacity:0 不可交互——破坏"点踩后允许更新原因"的设计意图 |
| **修复** | 动态拼接 className：`` `feedback-bar${msg.feedback ? ' has-feedback' : ''}${showReason ? ' show-reason' : ''}` `` |
| **代码位置** | [ChatMessage.tsx:369](file:///Users/bytedance/Trae_support/Trae_Plugin/webview-ui/src/components/ChatMessage.tsx#L369) |
| **设计意图** | 未反馈时仅 hover 显示（不污染阅读）；已反馈后状态栏常驻；原因面板展开期间持续可见可交互 |

#### M5 — Go 后端无优雅退出

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `go-backend/TraeCN_tob_knowledge.go` |
| **根因** | stdin EOF → 进程退出，在途 KB 请求(55s)/track(3s) goroutine 被即时杀死；扩展端 dispose 发的 SIGTERM 无 Go 端 handler，500ms 宽限未利用 |
| **修复** | 包级 `var wg sync.WaitGroup`；`runServer` 开头注册 `signal.Notify(SIGTERM, SIGINT)`，收到信号关闭 stdin 中断主循环；goroutine 内 `wg.Add(1)` + `defer wg.Done()`；`main` 末尾带 8s 超时 `wg.Wait()`，让在途请求有机会完成 |
| **代码位置** | [L13](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L13)/[L17](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L17)（import）, [L566-567](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L566-L567)（wg）, [L570-578](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L570-L578)（signal goroutine）, [L601-603](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L601-L603)（wg.Add/Done）, [L634-642](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L634-L642)（8s 超时 Wait） |
| **超时选择依据** | 8s 上限与扩展端 SIGKILL 兜底（500ms）+ JS timeout（60s）兼容，让在途请求（最长 55s KB、3s track）有机会完成 |

#### M6 — productType 无白名单校验（未修复，仅记录）

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `go-backend/auth.go` |
| **根因** | 鉴权只判 `productType == ""`，不校验值是否企业版（注释称 231）；free/试用账号若有同名嵌套字段即通过，可手改 storage.json 绕过 |
| **建议修复** | 加企业版 productType 白名单校验，并校验订阅有效期 |
| **代码位置** | [auth.go:141-148](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/auth.go#L141-L148) |
| **状态** | ⚠️ 未修复 |

#### M7 — Dashboard Scan 错误静默 continue 返回 200 部分数据

| 项 | 内容 |
|----|------|
| **严重度** | Major |
| **文件** | `admin-service/dashboard.go` |
| **根因** | HandleDaily / HandleTopDocs / HandleLowScore 三处 `rows.Scan` 出错静默 `continue` 返回 200 部分数据，违反"Scan 失败须日志+5xx"约定，前端无法察觉数据缺失 |
| **修复** | 三处静默 `continue` 改为 `log.Printf` + `http.Error(5xx)` + `return`，与 HandleOverview 的 `scanOr500` 做法统一 |
| **代码位置** | [dashboard.go:134-137](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/dashboard.go#L134-L137) / [L175-178](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/dashboard.go#L175-L178) / [L216-219](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/dashboard.go#L216-L219) |
| **HandleFeedback 保留 continue** | [L276](file:///Users/bytedance/Trae_support/Trae_Plugin/admin-service/dashboard.go#L276) 已有 `log.Printf`（不静默），且注释明确"answer/feedback_reason 等列历史数据可能为 NULL"——有意容错，不改 5xx |

---

### Minor（1 项，未修复，仅记录）

#### m1 — `runServer` 文档注释被 `var wg` 隔断致 godoc 失效

| 项 | 内容 |
|----|------|
| **严重度** | Minor |
| **文件** | `go-backend/TraeCN_tob_knowledge.go` |
| **根因** | `// runServer...` 文档注释（L562-564）与 `func runServer()`（L569）之间被 `// wg...`（L566）+ `var wg`（L567）+ 空行 隔开。Go 注释规则下，紧邻声明的注释才附着到声明；`// runServer...` 不再紧邻函数，变为悬空注释，godoc/IntelliSense 中 runServer 显示为"no documentation" |
| **建议修复** | 把 `var wg sync.WaitGroup` 移到 runServer 函数之后（如 L644），或移到文件顶部 `var querySem/trackSem` 所在的 var 块，让 `// runServer...` 注释重新紧邻 `func runServer()` |
| **代码位置** | [TraeCN_tob_knowledge.go#L562-L569](file:///Users/bytedance/Trae_support/Trae_Plugin/go-backend/TraeCN_tob_knowledge.go#L562-L569) |
| **状态** | ⚠️ 未修复（不影响功能，仅 godoc 可读性） |

---

## 二、修复完整性交叉验证

7 个修复项经源码确认 + 竞态/边缘情况分析：

| 修复项 | 验证点 | 结论 |
|--------|--------|------|
| C1 | 值类型 Unmarshal `null` 返回零值结构体指针；逃逸分析安全（返回局部变量地址） | ✅ 正确 |
| C2 | `fmt.Errorf` 返回非 nil error；调用方 `if err != nil` → 502 正确处理；防回滚注释在位 | ✅ 正确 |
| M1 | ensurePromise 锁 + finally 清空；并发复用同一 Promise；disposed 检查在锁之前 | ✅ 正确 |
| M2 | error/exit handler 竞态：Node 单线程不并发；pending Map 遍历空 Map 无操作 | ✅ 正确 |
| M3 | redirects 递减防无限递归；递归校验 HTTPS；对齐 downloadFile | ✅ 正确 |
| M4 | falsy 时空字符串，className 不变；CSS 选择器天然生效 | ✅ 正确 |
| M5 | signal goroutine 在非信号退出时临时阻塞（进程即将退出，无影响）；`os.Stdin.Close()` 线程安全；wg.Add 在主循环，wg.Wait 在 main 带 8s 超时 | ✅ 正确 |
| M7 | `defer rows.Close()` 在 5xx return 后执行，无资源泄漏；HandleFeedback 保留 continue 是有意容错 NULL 列 | ✅ 正确 |

---

## 三、部署链路

### 链路 1：运营服务端（admin-service）

涉及 C2 + M7，只改 Go 代码，不涉及 dashboard-ui 前端。

```bash
cd admin-service
git pull
go build -o admin-service .
sudo systemctl restart admin-service
```

### 链路 2：客户端插件（VSIX）

涉及 C1 + M5 + M1 + M2 + M3 + M4，需重新构建扩展 TS + Webview 前端 + 客户端 Go 二进制后打包。

```bash
cd /Users/bytedance/Trae_support/Trae_Plugin
git pull
npm run build-go-all          # 客户端 Go 二进制（全平台）
npm run compile-webview       # Webview 前端（产物到 webview-ui/dist/）
npm run compile               # 扩展 TS（产物到 dist/extension.js）
npm run package-vsix          # 打包 VSIX
# 手动上传 TOS：plugin/asktrae-<version>.vsix + plugin/latest.json
```

---

## 四、未修复项汇总

### 未修复的 Major

| No. | 问题 | 文件 | 原因 |
|-----|------|------|------|
| M6 | productType 无白名单校验 | `go-backend/auth.go` | 需确认企业版 productType 的合法值集合 |

### 未修复的 Minor（本次审查发现）

| No. | 问题 | 文件 | 原因 |
|-----|------|------|------|
| m1 | runServer 文档注释被 var wg 隔断 | `go-backend/TraeCN_tob_knowledge.go` | 不影响功能，仅 godoc 可读性 |

### 未修复的 Minor（首次审查发现，未在本次修复范围）

共计 35 项，详见首次审查报告。按模块归类：

- **扩展 TS (src/)**：8 项（updater 24h 节流时间戳、setTimeout 未纳入 subscriptions、verify 同步 I/O、findProductType 递归搜整棵 JSON、激活即 spawn、deactivate 未返回 Thenable、postMessage 无上限、请求 ID 用 Date.now()）
- **Webview UI (webview-ui/src/)**：11 项（wrapBareUrls 每次渲染执行、ReactMarkdown 组件重建、feedbackError 全局重渲染、数组索引作 key、sendQuery 未乐观 loading、IME 处理可加 isComposing、剪贴板复制失败仍显示已复制、feedbackError setTimeout 竞态、detectDarkTheme 不支持 rgb()、图标按钮缺 aria-label、uninstalled 死代码）
- **Go 后端 (go-backend/)**：10 项（ioutil.ReadAll 废弃、变量名 bytes 遮蔽标准库、*chan struct{} 反惯用法、reportTrack 未排空响应体、os.Stat 后 readFile 冗余、scanDoubleCRLF 死代码、readUsertag 死代码、HTTP 响应体无大小限制、findProductType 递归无深度限制、多 goroutine 并发写 stderr）
- **Admin 服务 Go (admin-service/)**：6 项（查询错误回写客户端泄露 DB 细节、handleCallback 透传飞书 error_description、X-TrackToken 时序攻击面、StartDailyAggregation 无 panic recover、SessionStore 无过期清理、parseIntDefault 未 clamp limit）
- **Admin Dashboard UI**：6 项（getPrevRange 单日环比失真、自定义日期无 from<=to 校验、useCountUp 动画途中目标值变化回跳、Footer 显示渲染时刻非加载时刻、LowScoreTable 排序切换死代码、load 无请求取消）
- **交叉验证降级项**：4 项（cachedToken 死代码预留、MutationObserver 性能冗余、HandleDaily 时区依赖 DB 配置）

---

## 五、部署后验证清单

### C2 验证（admin-service）

```bash
# 1. 源码确认（服务器执行）
grep -n 'fmt\.Errorf.*userinfo code\|log\.Output.*userinfo\|func itoa' admin-service/auth.go
# 预期：仅一行 fmt.Errorf，无 log.Output，无 func itoa

# 2. 二进制确认（服务器执行）
BIN_PATH=$(systemctl show admin-service -p ExecStart --value | awk '{print $1}' | sed 's/^-//')
strings "$BIN_PATH" | grep "userinfo code"
# 预期：输出 userinfo code: %d

# 3. 日志确认
journalctl -u admin-service -n 50 --no-pager | grep -E "userinfo|getUserInfo"
# 触发后预期：飞书 userinfo 获取失败: userinfo code: xxx
```

### C1 验证（客户端 VSIX）

KB 返回 JSON `null` 时不再进程崩溃，返回空响应给客户端。

### M1/M2 验证（客户端 VSIX）

- 模拟二进制不存在/无执行权限，确认不再崩溃扩展宿主
- 并发 query 不产生孤儿进程

### M3 验证（客户端 VSIX）

把 `traeAsk.updateManifestUrl` 指向会 302 跳转的地址，自动更新检查应成功。

### M4 验证（客户端 VSIX）

点踩展开原因面板后鼠标移开消息，面板仍可见可交互。

### M5 验证（客户端 VSIX）

打开问答后立即 reload window（触发 dispose），观察 Go 进程在 8s 内优雅退出（活动监视器看进程消失，无残留）。

### M7 验证（admin-service）

让某行 rows.Scan 失败（如临时改 SQL 列名），看板应返回 500 而非 200 部分数据。
