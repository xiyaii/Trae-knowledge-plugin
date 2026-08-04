# 知识库助手（Trae KB Assistant）

基于火山引擎知识库的智能问答 VS Code / Trae IDE 扩展。

## 工程结构

```
Trae_Plugin/
├── go-backend/              # Go 后端（JSON Lines 协议）
│   ├── TraeCN_tob_knowledge.go
│   └── go.mod
├── src/                     # 扩展端（TypeScript）
│   ├── extension.ts         # 激活入口
│   ├── webviewProvider.ts   # Webview 管理与消息分发
│   ├── goBridge.ts          # Go 子进程管理 + JSON Lines 通信
│   └── secrets.ts           # SecretStorage 密钥管理
├── webview-ui/              # 前端 UI（React + Vite）
│   └── src/
│       ├── App.tsx
│       ├── components/      # ChatMessage / InputBox
│       ├── hooks/useVsCode.ts
│       └── index.css
├── bin/                     # Go 编译产物（按平台命名）
├── media/                   # 图标
├── package.json             # 扩展清单
├── webpack.config.js        # 扩展端打包
└── tsconfig.json
```

## 架构

```
Webview (React) ──postMessage──► Extension Host ──JSON Lines──► Go 后端 ──HTTPS──► 火山引擎知识库
                                   │
                                   └─ SecretStorage: APIKey（不暴露给用户）
```

- APIKey 通过环境变量 `TRAE_KB_API_KEY` 注入 Go 子进程，不进代码、不进 git
- 扩展端与 Go 后端通过 stdin/stdout 的 JSON Lines 协议通信
- 用户登录态（Trae 企业版）已预留 `VerifyAuth` 接口，待鉴权方案确认后实现

## 开发

### 1. 编译 Go 后端

```bash
cd go-backend
GOOS=darwin GOARCH=arm64 go build -o ../bin/kb-server-darwin-arm64 .
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
# npm run build-go        # 编译 Go 二进制
# npm run compile-webview # 构建 React UI
# npm run package         # 打包扩展
```

### 4. 调试

用 VS Code / Trae IDE 打开本目录，按 `F5` 启动扩展开发宿主。
侧边栏将出现"知识库助手"图标，点击即可使用。

## JSON Lines 协议

**请求**（扩展 → Go）：
```json
{"id":"req-1","type":"query","query":"29元套餐电话卡","history":[]}
```

**响应**（Go → 扩展）：
```json
{"id":"req-1","type":"result","data":{"count":10,"doc_name":"...","content":"..."}}
{"id":"req-1","type":"error","error":"未配置 TRAE_KB_API_KEY"}
```

## 待办

- [ ] Trae 企业版鉴权：确认 OpenAPI 校验方式后实现 `VerifyAuth`
- [ ] APIKey 内置：改为从安全配置服务拉取，而非环境变量硬注入
- [ ] 流式输出：启用 `KBRequest.stream`，扩展端增量渲染
