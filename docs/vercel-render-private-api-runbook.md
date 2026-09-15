# Vercel / Render 私有 API 发布手册

**适用分支：** `codex/vercel-render-private-api`  
**目标：** Vercel Authentication 是唯一浏览器入口，Vercel Function 是唯一公网 API 代理，Render `/api/*` 拒绝匿名访问。

## 安全规则

- 不把任何真实 Secret、Vercel Protection Bypass 值、第三方 API Key 或 MCP Token 写入仓库、终端命令、聊天、截图或日志。
- `RENDER_PROXY_SECRET` 使用至少 32 个随机字节生成，并在 Vercel 与 Render 配置为相同值。
- `RENDER_PROXY_SECRET` 不使用 `NEXT_PUBLIC_`、`VITE_` 或其他客户端构建变量前缀。
- 生产日志只允许出现配置状态、路径、状态码、错误代码和耗时。
- Vercel All Deployments 必须保持启用，不新增公开 Shareable Link 或未保护的部署例外。

## 1. 生成服务端代理密钥

在本地密码管理器或受控终端生成一个值，例如：

```powershell
openssl rand -base64 32
```

生成后立即保存到密码管理器；不要把真实输出复制到 shell history、Markdown、Issue、聊天或截图中。

## 2. 配置 Vercel

在 Production 和 Preview 环境设置：

```text
RENDER_ORIGIN=https://warmbuddy.onrender.com
RENDER_PROXY_SECRET=<与 Render 完全相同的随机值>
```

在 Vercel Project Settings → Deployment Protection 确认：

```text
All Deployments = enabled
```

部署后确认根目录 `api/[...path].js` 被识别为 Node.js Function，且 `RENDER_PROXY_SECRET` 没有出现在客户端构建产物或浏览器响应中。

## 3. 第一阶段：Vercel 桥接发布

1. 从包含 Task 1–3 的提交部署 Vercel。
2. 在已认证浏览器中打开 Vercel 域名。
3. 验证页面加载、普通 JSON API、聊天 SSE、项目同步和工具配置读取。
4. 浏览器 Network 面板中的 API 请求必须全部使用 Vercel Origin。
5. 暂不把 Render `/api` 鉴权门部署到生产，直到上述检查完成。

## 4. 配置 cron-job.org

将现有 cron 目标从 Render 改为：

```text
https://warmbuddy.vercel.app/api/cron/check
```

在 cron-job.org 的请求头中设置 Vercel Protection Bypass for Automation 对应的官方请求头和值。真实值只保存在 cron-job.org，不写入本文件。

手动触发一次，并确认 cron 成功；失败时先恢复原目标，不锁定 Render API。

## 5. 配置 Render

Render 服务端设置：

```text
RENDER_PROXY_SECRET=<与 Vercel 完全相同的随机值>
APP_PUBLIC_ORIGIN=https://warmbuddy.vercel.app
NTFY_CLICK_BASE_URL=https://warmbuddy.vercel.app
```

Render Health Check Path 设置为：

```text
/healthz
```

确认 Render 服务的自动部署顺序可控。若 Git 分支会自动触发 Render 部署，在 Vercel 桥接验证完成前暂停 Render Auto-Deploy，或只从明确选择的提交手动部署。

## 6. 第二阶段：Render 锁定发布

桥接验证通过后部署 Render 锁定版本，然后运行：

```powershell
curl.exe -i https://warmbuddy.onrender.com/healthz
curl.exe -i https://warmbuddy.onrender.com/api/health
curl.exe -i https://warmbuddy.onrender.com/api/toolkit/definitions
```

预期：

- `/healthz` 返回 `200`，正文只有 `{"status":"ok"}`。
- 每个 `/api/*` 请求在无代理密钥时返回 `401` 和 `RENDER_API_UNAUTHORIZED`。
- 响应不包含配置、环境变量、密钥或调试细节。

然后从已认证的 Vercel 页面验证：

- `/api/health` 正常。
- 聊天 SSE 正常流式输出。
- 项目同步正常。
- 配置响应只返回 `hasApiKey`/`configured` 状态，不返回完整凭据。
- 当前设备的 MCP Token 仍可用。
- cron-job.org 和 Render 内部主动任务正常。

## 7. 生产日志检查

检查锁定发布前后日志，搜索以下模式：

```text
Authorization
apiKey
tokenSha256
tokenLength
raw body
Raw sample
```

不得出现第三方 API Key、MCP Token、代理密钥、密钥片段、哈希、长度或请求正文。

## 8. 回滚

若 Vercel 经代理访问失败：

1. 保留 Vercel 和 Render 两端的 `RENDER_PROXY_SECRET`。
2. 将 Render 恢复到锁定前版本，使当前业务恢复。
3. 不把代理密钥加入浏览器，也不增加匿名 Render API 旁路。
4. 修复后重新执行桥接验证和锁定发布。

## 9. 密钥轮换

发现代理密钥可能泄露时：

1. 生成新值并同时更新 Vercel 与 Render。
2. 先部署/配置 Vercel，再部署 Render。
3. 验证旧值不能访问 Render、新值可通过 Vercel 工作。
4. 不记录旧值或新值本身。

本手册不记录任何真实凭据，也不负责第三方 LLM API Key/MCP Token 的轮换。
