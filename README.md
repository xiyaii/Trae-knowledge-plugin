# 知识库助手（Trae KB Assistant）

基于火山引擎知识库的智能问答 Trae IDE 扩展，面向 Trae 企业版用户，提供开箱即用的技术问答能力。

## 功能

- **智能问答**：基于火山引擎知识库检索，返回高相似度匹配结果
- **多轮对话**：支持上下文历史，保留最近 N 轮（可配置）
- **企业版鉴权**：自动校验 Trae 企业版订阅状态，Free 用户无法使用
- **安全无感**：APIKey 编译期内置，用户无需配置，密钥不暴露
- **中文输入友好**：正确处理 IME 输入法合成期，避免 Enter 误发送
- **内容清洗**：自动去除知识库切片元信息标签，仅展示问题表现和解决方案
- **埋点上报**：install / login_success / query 事件异步上报到运营服务端，不影响主流程
- **运营看板**：独立 admin-service 提供 DAU、问答次数、平均得分、低分问答列表等指标可视化

## 工程结构

```
Trae_Plugin/
├── go-backend/              # Go 后端（JSON Lines 协议，随 VSIX 分发）
│   ├── TraeCN_tob_knowledge.go   # 知识库 API 调用 + 检索逻辑 + 埋点转发
│   └── go.mod
├── admin-service/           # 运营服务端（独立部署，连 PostgreSQL）
│   ├── main.go              # HTTP 服务入口 /track + /dashboard/* + /auth/*
│   ├── handler.go           # 埋点上报接口（X-Track-Token 鉴权）
│   ├── auth.go              # 飞书 SSO 登录（OAuth 2.0 + Session）
│   ├── dashboard.go         # 看板 API（overview/daily/top-docs/low-score）
│   ├── dashboard_embed.go   # go:embed 静态前端
│   ├── store.go             # pgx 数据访问 + 每日聚合
│   ├── config.go            # 环境变量配置
│   ├── admin.service        # systemd unit 模板
│   ├── dashboard-ui/        # 运营看板前端（React + Vite）
│   └── static/              # 构建产物（go:embed 打包）
├── src/                     # 扩展端（TypeScript）
│   ├── extension.ts         # 激活入口，注册视图和命令 + install 埋点
│   ├── webviewProvider.ts   # Webview 管理与消息分发
│   ├── goBridge.ts          # Go 子进程管理 + JSON Lines 通信
│   ├── auth.ts              # 企业版登录鉴权（读取 storage.json）
│   └── secrets.ts           # SecretStorage 密钥管理（预留）
├── webview-ui/              # 前端 UI（React + Vite）
│   └── src/
│       ├── App.tsx          # 主界面（登录页 / 问答页切换）
│       ├── types.ts         # 共享类型定义
│       ├── components/
│       │   ├── ChatMessage.tsx   # 消息渲染（Markdown）
│       │   └── InputBox.tsx      # 输入框（IME 合成处理）
│       ├── hooks/useVsCode.ts    # VS Code API 获取
│       └── index.css
├── bin/                     # Go 编译产物（按平台命名）
├── media/                   # 图标资源
├── package.json             # 扩展清单
├── webpack.config.js        # 扩展端打包配置
├── vite.config.ts           # Webview 构建配置（IIFE 格式）
└── tsconfig.json
```

## 架构

```
Webview (React) ──postMessage──► Extension Host ──JSON Lines──► Go 后端 ──HTTPS──► 火山引擎知识库
     │                                │                       │
     │                                ├─ auth.ts: 读取 storage.json 校验 productType
     │                                └─ goBridge.ts: 管理子进程生命周期
     │                                                        │
     │                                                        └─ 异步 HTTP POST /track
     │                                                              (2s 超时, 失败静默)
     │                                                                   │
     │                                                                   ▼
     │                                                        ┌───────────────────────────┐
     │                                                        │ admin-service (独立部署)     │
     │                                                        │  /track → PostgreSQL        │
     │                                                        │  /dashboard/* (飞书 SSO)     │
     │                                                        │  /auth/* (OAuth 2.0 回调)    │
     │                                                        └───────────────────────────┘
     │                                                                   │
     └─ IME 合成状态管理，避免输入法选词时 Enter 误发送                 └─ go:embed 静态前端
```

埋点链路为两段式：plugin 不直接访问 admin-service，而是发到本地 go-backend（type:'track'），由 go-backend 携带编译期内置的 `trackEndpoint`/`trackToken` 转发到运营服务端。query 事件由 go-backend 自身生成（携带 score/doc_name 等检索结果）。

### APIKey 安全方案

APIKey 通过 Go 编译期 `ldflags -X main.builtInAPIKey` 注入，嵌入在二进制中：

- `.apikey` 文件存放密钥（已 gitignore，不进仓库）
- 编译时读取并注入：`go build -ldflags "-X main.builtInAPIKey=$(cat ../.apikey)"`
- 运行时优先使用环境变量 `TRAE_KB_API_KEY`，其次使用编译期内置值
- JS 层完全不接触密钥，用户无感知

### 埋点与运营看板（admin-service）

`admin-service` 与 `go-backend` 完全解耦：独立 `go.mod`、独立部署（systemd）、独立连 PostgreSQL。两者唯一耦合是 go-backend 编译期内置的 `trackEndpoint` URL。

**埋点事件**（go-backend 异步 POST 到 `/track`，`X-Track-Token` 鉴权）：

| Event | 触发点 | 关键字段 |
|---|---|---|
| `install` | 扩展首次激活（`extension.ts` globalState 去重） | `machine_id`、`platform`、`plugin_ver` |
| `login_success` | 用户点击"验证企业版订阅"且通过（`webviewProvider.ts`） | `user_id`（iCubeAuthInfo://usertag）、`machine_id` |
| `query` | go-backend 完成知识库检索后自行生成（含低分命中） | `user_id`、`query`、`score`、`doc_name`、`msg_id` |

**Dashboard 接口**（`/dashboard/*`，飞书 SSO Session 鉴权）：

| Path | 说明 |
|---|---|
| `/dashboard/overview?from=&to=` | 累计激活/登录数、区间问答次数、今日 DAU、平均得分、低分占比 |
| `/dashboard/daily?from=&to=` | 按日聚合的 install/login/query/DAU 趋势 |
| `/dashboard/top-docs?from=&to=&limit=10` | 命中频次 Top 文档 |
| `/dashboard/low-score?from=&to=&limit=20` | score < 0.3 的低分问答列表（**不含 user_id**，仅返回 query/score/doc_name/ts），供人工补充知识库 |
| `/` | go:embed 打包的 React 静态前端 |

**配置注入**（systemd Environment）：

| 变量 | 用途 |
|---|---|
| `PORT` | HTTP 监听端口（默认 8080） |
| `DB_DSN` | PostgreSQL 连接串 |
| `TRACK_TOKEN` | `/track` 接口鉴权 token，需与 go-backend 编译期注入值一致 |
| `DASHBOARD_USER` / `DASHBOARD_PASS` | 兜底 BasicAuth 账号密码（当前未启用，保留） |
| `LARK_APP_ID` | 飞书自建应用 App ID |
| `LARK_APP_SECRET` | 飞书自建应用 App Secret |
| `LARK_REDIRECT_URL` | OAuth 回调地址，如 `http://115.191.37.157:8080/auth/callback` |
| `ALLOW_LARK_USERS` | 可选：飞书 user_id 白名单（逗号分隔），为空则允许所有飞书用户 |

`/track` 接口公开（仅 token 鉴权），`/dashboard/*` 与根路径前端均走飞书 SSO Session 鉴权。

### 飞书 SSO 登录（admin-service）

运营看板使用飞书 OAuth 2.0 授权码流程登录，流程如下：

```
浏览器 ──► /auth/login ──302──► 飞书授权页
                                  │ 用户授权
                                  ▼
浏览器 ◄──302── /auth/callback ◄── 飞书回跳 code
                │
                ├─ code 换 user_access_token
                ├─ token 换 userinfo (user_id / name)
                ├─ 写入内存 Session（TTL 7 天）
                └─ Set-Cookie: admin_session=xxx ──302──► /
```

**路由**（`/auth/*`，公开免鉴权）：

| Path | 说明 |
|---|---|
| `/auth/login` | 生成 state 防 CSRF，302 跳转飞书授权页 |
| `/auth/callback` | 接收 code，换 token + userinfo，写 session cookie 后 302 回 `/` |
| `/auth/logout` | 清除 session cookie，302 回 `/auth/login` |
| `/auth/me` | 返回当前登录用户信息（user_id / name），前端启动时调用 |

**Session 机制**：
- 内存存储（单机够用，重启失效需重新登录）
- Cookie 名 `admin_session`，`HttpOnly` + `SameSite=Lax`，TTL 7 天
- 临近过期（< 10 分钟）自动后台刷新 `user_access_token`

**飞书后台配置**（[open.feishu.cn/app](https://open.feishu.cn/app)）：
1. 创建自建应用，获取 App ID / App Secret
2. 安全设置 → 重定向 URL 填 `http://115.191.37.157:8080/auth/callback`（精确匹配）
3. 权限管理 → 开通「获取用户身份信息」「获取用户 user ID」
4. 应用可用范围 → 添加运营人员
5. 创建版本并发布（自建应用必须发布才生效）

### 登录鉴权

插件启动时读取 Trae 本地 `storage.json`，校验 `iCubeServerData://icube.cloudide` 字段：

| 条件 | 结果 |
|---|---|
| `productType` 字段存在 | 登录成功，进入问答界面 |
| `productType` 字段不存在 | 登录失败，提示未购买企业版 |
| `storage.json` 不存在 | 登录失败，提示先登录 Trae 账号 |

`productType` 位于 `saasEntitlementInfo.productType`，值为数字类型（如 `231`），只要存在即视为企业版用户。


storage.json 路径：
- macOS: `~/Library/Application Support/Trae CN/User/globalStorage/storage.json`
- Windows: `%APPDATA%/Trae CN/User/globalStorage/storage.json`
- Linux: `$XDG_CONFIG_HOME/Trae CN/User/globalStorage/storage.json`

### 检索逻辑

1. 调用火山引擎知识库 API，获取 top10 检索结果
2. 按 `score` 选取最高分作为最佳匹配
3. 得分 < 0.2 视为未命中，返回"知识库未检索到相关内容，请寻找Trae技术支持进行确认"
4. 清理 `content` 中的 `<KBDirectory>`、`<KBDocName>` 等切片元信息标签
5. 仅返回问题表现和解决方案

## 开发

### 1. 编译 Go 后端

```bash
cd go-backend
GOOS=darwin GOARCH=arm64 go build -ldflags "-X main.builtInAPIKey=$(cat ../.apikey)" -o ../bin/kb-server-darwin-arm64 .
# 如需其他平台：
# GOOS=darwin GOARCH=amd64 go build -o ../bin/kb-server-darwin-amd64 .
# GOOS=linux  GOARCH=amd64 go build -o ../bin/kb-server-linux-amd64  .
```

### 2. 安装依赖

```bash
# 扩展端
npm install

# Webview
cd webview-ui && npm install && cd ..
```

### 3. 构建

```bash
npm run build-all
# 等价于：
# npm run build-go        # 编译 Go 二进制（含 APIKey 注入）
# npm run compile-webview # 构建 React UI（IIFE 格式）
# npm run package         # 打包扩展端
```

### 4. 打包 VSIX

```bash
npx vsce package
# 生成 trae-kb-assistant-0.1.0.vsix
```

### 5. 安装

Trae IDE → 扩展面板 → 更多操作 → 从 VSIX 安装 → 选择生成的 `.vsix` 文件 → 重启 IDE。

## JSON Lines 协议

**请求**（扩展 → Go）：
```json
{"id":"req-1","type":"query","query":"pod长时间pending什么问题","history":[]}
```

**响应**（Go → 扩展）：
```json
{"id":"req-1","type":"result","data":{"count":10,"doc_name":"VKE_高频问题FAQ.md","score":0.35,"content":"问题表现\n新创建的 Pod 长时间处于 Pending 状态..."}}
{"id":"req-1","type":"error","error":"APIKey 未配置"}
```

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `kbAssistant.serviceResourceId` | `kb-service-39d7c93c630152d` | 火山引擎知识服务 ID |
| `kbAssistant.maxHistory` | `10` | 多轮对话保留的历史轮数 |

## 待办

- [x] Trae 企业版鉴权：读取本地 `storage.json` 校验 `productType` 字段
- [x] APIKey 内置：通过 Go 编译期 `ldflags -X` 注入，JS 层零密钥接触
- [x] IME 输入法修复：合成期 Enter 不触发发送
- [x] 内容清洗：去除 `KBDirectory`/`KBDocName` 等切片元信息
- [x] 检索阈值：score < 0.2 视为未命中
- [x] 埋点上报：install / login_success / query 三类事件，go-backend 异步转发到 admin-service
- [x] 运营看板：admin-service 提供 overview/daily/top-docs/low-score API + React 静态前端
- [x] 运营看板 SSO 登录：飞书 OAuth 2.0 授权码流程 + 内存 Session + token 自动刷新
- [ ] 流式输出：启用 `KBRequest.stream`，扩展端增量渲染
- [ ] 多平台二进制：按 OS/ARCH 自动选择对应编译产物
- [ ] 服务端鉴权：go-backend `VerifyAuth` 当前为桩实现（空 token 也放行），上线前需接入 Trae 企业版 OpenAPI
