# Vercel 可信入口与 Render 私有 API 设计

**日期：** 2026-09-14  
**状态：** 已确认，待实施  
**范围：** 最小安全修复，不建设完整凭据托管系统

## 1. 目标

把 Vercel 变成 WarmBuddy 唯一可信的浏览器入口：用户先通过 Vercel Authentication，再由 Vercel 服务端代理访问 Render。Render 的所有 `/api/*` 请求必须持有仅存在于服务端的 `RENDER_PROXY_SECRET`，匿名浏览器不得直接调用。

同时缩小现有第三方凭据的暴露面：配置读取接口不返回完整 LLM API Key 或 MCP Token，服务端日志不记录这些凭据、凭据指纹或可能包含凭据的请求/响应正文。

## 2. 明确不在本轮处理的事项

- 不增加登录限速或失败次数限制。
- 不解决单一共享密码无法区分用户、无法撤销单个用户权限的问题。
- 不把用户主动填写的第三方 LLM API Key 或 MCP Token 迁移成完整的服务端凭据托管系统。
- 不重构 Supabase RLS、数据库结构或多用户账户体系。
- 不改变 LLM、MCP、消息同步、主动消息的业务语义。
- 不自动轮换已经存在的第三方凭据。

## 3. 当前状态

### 3.1 当前数据流

```text
浏览器 ──访问页面──> Vercel 静态站点
   └────匿名跨域请求────────────> Render /api/*
                                      ├─> Supabase
                                      ├─> 第三方 LLM
                                      ├─> MCP 服务
                                      └─> 通知服务
```

### 3.2 已确认的代码事实

- `vercel.json` 当前只声明静态输出目录 `public`。
- `public/js/app-core.js` 和 `public/js/memory.js` 在生产环境直接使用 `https://warmbuddy.onrender.com`。
- `server.js` 当前对所有 `/api/` 绕过旧共享密码校验，并启用无条件 `cors()`。
- Render 同时提供静态页面、共享密码入口和 API；共享密码还存在代码内默认值。
- `/api/projects/sync-configs` 的读取模式可返回完整项目配置。
- `/api/toolkit/definitions` 和 `/api/tools/enabled` 可返回完整工具定义，包括认证 Token。
- 部分调试日志记录 Authorization 片段、Token 长度/哈希、MCP 原始响应和流式原始样本。
- Render 内部任务通过 localhost 调用自己的 `/api/chat`、`/api/log-token-call` 和 `/api/projects/sync-configs`。
- `cron-job.org` 当前直接调用 Render 的 `/api/cron/check`。

### 3.3 风险排序

1. **最高：Render API 可绕过 Vercel Authentication 匿名直连。** 启用 All Deployments 只保护 Vercel 入口，无法保护当前独立公开的 Render API。
2. **高：读取响应可能泄露完整第三方凭据。** 任何获得 API 访问能力的人都可能取得 LLM API Key 或 MCP Token。
3. **高：日志扩大凭据泄露面。** 前缀、长度、哈希以及原始正文会进入日志存储和运维查看链路。
4. **中：Render 页面入口与 Vercel 并存。** 用户可绕过 Vercel，旧书签和通知链接也可能继续进入 Render。
5. **中：直接锁定 API 会破坏内部任务、健康检查和外部 cron。** 必须在锁定前建立受信调用路径。

## 4. 方案选择

### 4.1 采用方案

采用“Vercel Authentication + 同源 Serverless Proxy + Render 共享服务密钥”的方案。

```text
浏览器
  │
  ▼
Vercel Authentication
  │
  ├─> public/* 静态资源
  │
  └─> /api/* Vercel Function
          │ 固定上游 + 注入 RENDER_PROXY_SECRET
          ▼
      Render /api 鉴权门
          │
          ▼
      现有 Express 路由和业务依赖
```

### 4.2 未采用的方案

- **浏览器直接携带 Render 密钥：** 密钥必然进入 JavaScript、构建产物、浏览器存储或网络面板，不满足目标。
- **浏览器登录 Render 并使用跨站 Cookie：** 会引入第二套会话、跨站 Cookie/CORS 和明显的登录体验变化。
- **仅使用 Vercel 外部 rewrite：** 难以可靠控制隐藏请求头、剥离浏览器头、错误语义和敏感日志；不作为本轮安全边界。
- **立即建设每用户凭据托管：** 超出单用户、最小修复范围，改动和迁移风险过大。

## 5. 信任边界与安全不变量

### 5.1 信任主体

- Vercel Authentication 是浏览器访问的身份边界。
- Vercel Serverless Function 是唯一允许从公网调用 Render `/api/*` 的代理。
- Render 内部任务使用同一秘密通过本机 HTTP 调用 API，但不获得匿名豁免。
- Render `/healthz` 是唯一计划保留的匿名运行状态端点。

### 5.2 必须保持的不变量

- `RENDER_PROXY_SECRET` 只能存在于 Vercel 和 Render 的服务端环境变量中。
- `RENDER_PROXY_SECRET` 不得出现在 `public/`、客户端响应、HTML、JavaScript、Source Map、日志、错误信息或提交历史中。
- Vercel 代理只访问固定的 `RENDER_ORIGIN`，请求不能选择任意上游。
- 浏览器提交的同名代理密钥请求头必须被丢弃并由代理覆盖。
- Vercel 登录 Cookie、平台 Authorization 和 Protection Bypass 头不得继续转发给 Render。
- Render `/api/*` 缺少或携带错误密钥时默认拒绝。
- localhost、Origin、Referer、IP 和 User-Agent 均不能代替密钥。
- 读取型接口不能返回完整 API Key、Token 或带敏感查询参数的 URL。
- 日志不能记录完整或局部凭据、凭据哈希、凭据长度、请求正文、原始上游正文。

## 6. 组件设计

### 6.1 Vercel 同源代理

新增 `api/[...path].js` 作为薄入口，把工作委托给可测试的 `vercel-render-proxy.js`。

代理配置：

- `RENDER_ORIGIN`：固定 Render Origin，非秘密，例如 `https://warmbuddy.onrender.com`。
- `RENDER_PROXY_SECRET`：至少 32 个随机字节生成的不可预测值。
- 内部请求头名：`X-WarmBuddy-Proxy-Secret`。

代理行为：

1. 只接受路径以 `/api/` 开头的请求。
2. 只允许 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS`。
3. 使用固定 Origin 加原始 pathname/query 构造上游 URL，不读取用户提供的上游地址。
4. 请求头只转发 `accept`、`content-type`、`if-none-match`、`last-event-id`。
5. 无正文方法不转发 body；其他方法最多读取 5 MiB，与 Render 现有限制一致。
6. 覆盖注入 `X-WarmBuddy-Proxy-Secret`。
7. 响应只复制 `content-type`、`cache-control`、`etag`、`content-disposition`、`retry-after`，并默认设置 `Cache-Control: no-store`。
8. 使用流式管道转发响应，不先缓冲完整 SSE/LLM 输出。
9. 缺少配置返回 `503 PROXY_NOT_CONFIGURED`；上游失败返回 `502 UPSTREAM_UNAVAILABLE`；正文超限返回 `413`。
10. 日志仅记录 method、pathname、status、durationMs；不记录 query、headers、body 或错误对象中的敏感字段。

Vercel All Deployments 必须持续开启，且不得新增公开 Shareable Link 或未受保护的部署例外。代码无法在运行时可靠补偿平台保护被关闭的情况，因此这是运行配置不变量。

### 6.2 Render API 鉴权门

新增 `render-api-security.js`，提供以下接口：

```js
createRenderApiGuard({ secret, headerName }) -> Express middleware
sanitizeProjectConfigForClient(config) -> object|null
sanitizeToolDefinitionForClient(definition) -> object
sanitizeToolDefinitionsForClient(definitions) -> object[]
```

鉴权中间件放在 `express.json()` 之前，只处理 `/api` 和 `/api/*`：

- 没有服务端密钥时生产进程启动失败，不以匿名模式降级。
- 对固定长度 SHA-256 摘要使用 `crypto.timingSafeEqual`，避免长度差和普通字符串比较。
- 未提供或错误密钥返回相同的 `401` JSON：`{"error":"Unauthorized","code":"RENDER_API_UNAUTHORIZED"}`。
- 不在响应或日志中区分“缺少”和“错误”。

本地开发和测试仍必须显式设置一个测试密钥，不增加开发环境匿名旁路。

### 6.3 Render 页面和健康检查

- 新增公共 `GET /healthz`，只返回 `{"status":"ok"}`。
- `/api/health` 保留但受 API 鉴权保护。
- Render 生产环境的根路径和静态页面请求不再提供应用，使用 `302` 跳转至服务端环境变量 `APP_PUBLIC_ORIGIN`；非 Render 的本地开发仍可通过 Express 提供 `public/`。
- 跳转只保留明确允许的 `project`、`chat` 参数；丢弃 `pwd` 和其他参数。
- 移除旧 `ACCESS_PASSWORD` 页面校验、代码内默认密码和 `cookie-parser` 使用；本地静态开发不附带这套旧密码页。
- `NTFY_CLICK_BASE_URL` 改为 Vercel 正式域名。

### 6.4 Render 内部调用

在 `render-api-security.js` 提供：

```js
createInternalApiFetch({ origin, secret, fetchImpl })
  -> internalApiFetch(path, init) -> Promise<Response>
```

该客户端：

- 只接受以 `/api/` 开头的相对路径。
- 固定访问 `http://127.0.0.1:${PORT}`。
- 复制调用方必要 headers，并覆盖内部密钥头。
- 替换当前四处 localhost `fetch`。
- 不记录 body 或密钥。

这保证内部任务通过同一个鉴权门，不引入 localhost 绕过。

### 6.5 配置读取脱敏

项目配置读取采用白名单返回：

```json
{
  "enabled": true,
  "hasApiKey": true,
  "_desireState": {},
  "_userStatus": {},
  "_aiStatus": {}
}
```

`hasApiKey` 只表示非空凭据存在。`apiKey`、`token`、`authorization`、`secret` 和其他未列字段不返回。

工具定义读取保留业务元数据，但认证字段只返回状态：

```json
{
  "id": "tool-id",
  "name": "Tool name",
  "description": "...",
  "transport": "streamable-http",
  "url": "https://mcp.example/path",
  "auth": {
    "type": "bearer",
    "configured": true
  }
}
```

URL 中名为 `token`、`key`、`api_key`、`apikey`、`access_token`、`auth`、`authorization`、`secret` 的查询参数必须移除。无法解析的 URL 不原样返回，改为空字符串。

脱敏应用到：

- `/api/projects/sync-configs` 的读取模式。
- `/api/projects/configs` 的所有读取响应。
- `GET /api/toolkit/definitions`。
- `GET /api/tools/enabled`。

写接口和既有后端使用方式不变，因此这不是凭据托管迁移。

### 6.6 客户端脱敏合并

`public/js/toolkit.js` 当前采用“服务端同 ID 定义完全覆盖本地定义”。服务端脱敏后，必须改为字段合并：

- 服务端非敏感元数据继续覆盖本地旧元数据。
- 服务端 `auth.configured` 只显示状态，不能覆盖本地 `auth.token`。
- 本地存在 Token 时始终保留。
- 本地没有 Token 时不得把掩码或状态值当作 Token。

结果：当前设备体验不变；新设备不会从读取接口获得完整 Token，需要重新填写。此变化是缩小读取暴露面的直接结果。

### 6.7 日志策略

必须移除：

- LLM/MCP/Agent Gateway Authorization 前缀。
- Token、API Key、私钥的长度、哈希、首尾字符。
- MCP 请求/响应正文和 SSE 解析结果正文。
- 低 chunk 数时的 LLM 原始流样本。
- 自动生成 VAPID 私钥的完整输出。
- 可能包含凭据的 headers、query、配置对象和错误 dump。

允许保留：

- `tokenConfigured: true|false`。
- provider、工具名称、HTTP 状态、错误代码、耗时、非敏感计数。
- `error.message` 仅在已确认上游不会回显请求凭据时使用；否则映射为稳定错误代码。

## 7. 修复后的数据流

### 7.1 浏览器业务请求

```text
已登录浏览器
  → https://warmbuddy.vercel.app/api/...
  → Vercel Function 注入隐藏密钥
  → https://warmbuddy.onrender.com/api/...
  → Render 鉴权通过
  → 现有业务处理
```

### 7.2 Render 内部任务

```text
Render cron/主动消息
  → internalApiFetch('/api/...') 注入隐藏密钥
  → 同一 Render API 鉴权门
  → 现有业务处理
```

### 7.3 外部 cron

```text
cron-job.org
  → Vercel /api/cron/check
     携带 Vercel Automation Protection Bypass 凭据
  → Vercel 平台验证后进入 Function
  → Function 注入 Render 密钥
  → Render 鉴权门
```

Automation Bypass 凭据只存放在 cron-job.org，不进入网页或浏览器代码。

### 7.4 健康检查

```text
Render 平台 → Render /healthz → {"status":"ok"}
```

## 8. 用户体验

- 不增加 WarmBuddy 应用内登录框或二次密码。
- 已登录用户继续直接打开网页；登录失效时由 Vercel Authentication 处理。
- 前端请求改为同源，聊天、同步、MCP 和 SSE 的调用形式不变。
- Render 旧书签自动跳转 Vercel。
- 当前设备保存的第三方凭据继续使用。
- 唯一预期差异是：新设备不再能从服务端读取完整 MCP Token，需要重新填写。

## 9. 两阶段发布与回滚

### 9.1 第一阶段：桥接

1. 生成至少 32 随机字节的 `RENDER_PROXY_SECRET`。
2. 同时设置 Vercel 和 Render 的密钥，并在 Vercel 设置 `RENDER_ORIGIN`。
3. 部署 Vercel Function、同源前端和读取脱敏/日志收紧代码；此时 Render API 暂不强制鉴权。
4. 从 Vercel 验证普通 API、SSE、配置读取和工具使用。
5. 将 cron-job.org 改到 Vercel，并配置 Automation Protection Bypass。

部署顺序是强制安全门：在桥接验证完成前，不得把 Render 鉴权门部署到生产。如果同一 Git 分支会自动触发 Render 部署，应暂停 Render Auto-Deploy，或让锁定阶段提交暂时不进入该跟踪分支；不得为方便发布而增加临时匿名旁路开关。

第一阶段回滚：把 Vercel 部署回上一版本；Render 尚未锁定，不中断现有访问。

### 9.2 第二阶段：锁定

1. 部署 Render API 鉴权门、内部调用客户端、`/healthz` 和页面跳转。
2. Render Health Check 改为 `/healthz`。
3. `NTFY_CLICK_BASE_URL` 与 `APP_PUBLIC_ORIGIN` 改为 Vercel 正式域名。
4. 验证 Vercel 正常、Render `/api/*` 匿名请求被拒绝、cron 正常。

第二阶段回滚优先恢复上一版 Render，同时保留 Vercel Proxy；不要删除密钥。问题排除后重新执行锁定。

## 10. 验收标准

- 登录用户可通过 Vercel 正常使用页面、普通 API 和 SSE。
- 未登录用户被 Vercel Authentication 阻止。
- Render `/api/health`、聊天、配置、工具接口在无密钥和错误密钥时均返回 `401`。
- Render `/healthz` 匿名访问返回 `200`，响应中无时间戳、版本、依赖或环境信息。
- Vercel Function 能转发状态码、JSON 和流式响应，并覆盖浏览器伪造的代理密钥头。
- `public/`、前端响应和浏览器网络请求中不存在 `RENDER_PROXY_SECRET`。
- 项目配置和工具定义读取响应中不存在完整 API Key、Token 或敏感 URL 参数。
- 服务端日志中不存在测试凭据、凭据片段、哈希、长度和原始正文。
- 当前设备的本地 MCP Token 不被脱敏响应覆盖。
- cron-job.org 通过 Vercel 成功执行。
- Render 内部主动任务通过带密钥的本机调用正常执行。
- 全量 `npm test` 通过，`git diff --check` 无错误。

## 11. 运维注意事项与剩余风险

- Vercel All Deployments、成员权限和 Protection Bypass 配置属于关键安全边界；关闭保护会使代理成为公开网关。
- 共享 Render 密钥只能整体轮换，不能区分调用者；这符合当前单用户范围。
- Render Origin 仍公开可达，但业务 API 会在应用层拒绝匿名访问；Render 托管能力没有提供本轮可依赖的私网边界。
- Supabase 当前安全策略不在本轮改变，仍建议后续单独审计 RLS 和公开授权。
- 第三方凭据仍可能按照现有写入流程存于浏览器和服务端数据中；本轮只减少读取和日志泄露，不等同于零知识或加密托管。
