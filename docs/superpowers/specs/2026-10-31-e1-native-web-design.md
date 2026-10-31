# WarmBuddy E1-A Native Web Design

## Intent

让 WB 的 Codex 回合能够在不暴露 Gateway 内部信息的前提下接收并展示 Gateway 的 `activity`/`source` 回执，并由服务端决定 Codex 网页模式。首版只覆盖 E1-A；生产 native 模式保持关闭。

## Goals

- 保留既有 `session/status/message/error/completion` 协议、取消、背压、超时、会话隔离和 completed 副作用门槛。
- 在 `legacy` 与 `native` 间做服务端控制的分流；默认 `legacy`，浏览器只读取非敏感模式名。
- 严格验证并裁剪 `activity/source`，按 `(requestId, activityId)` 与 `(requestId, sourceId)` 关联。
- 将有界回执摘要保存到现有 Codex 消息同步 metadata，不把回执重新注入模型上下文。
- 在重载、取消、错误、EOF、网络断开时结束本地活动，不能留下永久运行状态。

## Non-goals

不实现文件上传、PDF/OCR、图片输入、GitHub MCP、小红书、自动任务、模型切换、普通模型搜索重构或 Gateway 工程合入。

## Constraints

- Gateway 协议依据为用户提供的 `review (3).zip` 中 `docs/e1-native-web.md`、`src/web-receipts.mjs` 及其合成事件测试；ZIP 不是 WB 源码。
- WB 请求体仍只允许 `prompt` 与可选 `sessionId`；session sidecar、thread ID、原始工具结果、查询词和签名 URL 不进入浏览器或同步 metadata。
- CODEX_WEB_MODE 启动时缺省为 legacy；显式值只能是 legacy/native，非法启动值直接 fail fast。native 发布还必须在 Gateway 侧配置 CODEX_GATEWAY_E1_NATIVE_WEB=1。
- `source.url`/`targetUrl` 只有再次通过明确 HTTP(S) 绝对地址校验且未 redacted 时可点击；`displayUrl` 永不作为 href 兜底。

## Approaches

1. **前端直接解析任意新增 SSE 字段**：改动表面小，但会把协议安全边界移到浏览器，无法保证 Render/Gateway adapter 不透传内部结果，且同步难以复用。弃用。
2. **通用 SSE 透明转发，UI 猜测 activity**：Render 可以保持透明，但“是否调用工具”不能代表 native 模式，且无法可靠关联 source 与 activity。弃用。
3. **服务端严格协议适配 + 前端本地回执状态（采用）**：Gateway adapter 验证事件形状、顺序和限额；Render 保持原始 SSE 字节转发并回归验证；前端严格解码并把有界回执摘要挂在本轮用户消息的 Codex metadata 上。这样支持 source 晚于 activity completed、重载恢复展示和现有排序/终态同步，同时不污染模型上下文。

## Design

### Mode control

Render 进程在启动时读取 CODEX_WEB_MODE。GET /api/codex/config 只返回 {webMode}，响应和浏览器请求均为 no-store。浏览器每个新 Codex 回合重新读取该值；缺字段、非法值、JSON 错误、非 2xx 或网络错误都受控终止本轮，不猜测 legacy，请求 JSON 不新增模式字段。同一回合固定取得的模式。WB native 解析器只在 native 模式接受 activity/source。发布或回退切换期间暂停 Codex 请求，并先处理旧页面；回退先关闭 Gateway native，再切 WB legacy。

### Protocol boundary

`codex-gateway.js` 和 `public/js/codex.js` 都保留旧五类事件，并只接受协议列出的 `activity/source`。未知顶层事件、非法容器、错误的 request/activity/source 关联、重复终态、超出 64 activities 或每 activity 8 sources 都失败；单个合法回合中的无效来源只被丢弃。所有新增 payload 只输出 allowlist 字段。

### UI and persistence

前端把活动按 request/activity 建立状态，把 source 挂到所属 activity；活动显示“正在查阅/搜索/打开网页”，completed 且 outcome=unknown 时显示“搜索动作已结束/打开网页动作已结束/查阅动作已结束”，不宣称网页成功打开或全文读取。`sources=none/unknown` 不是失败。回执折叠卡使用现有 tool panel 的视觉语言，文本全部 escape；只有准确、未 redacted 的 URL 渲染链接；仅在确实发生摘要裁剪时显示省略提示，若裁剪的是非来源详情则不得声称来源被省略。

回执摘要写入本轮用户消息的 `_codexReceipts`，同步时映射为 metadata `receipts`。前后端共同校验结构、数量、字段和总字节数；未超过 64 KiB 时保留合法 target、来源和已有 omitted 信息，不新增 omitted；确实超过 64 KiB 时保留全部 activity 身份与终态，按确定顺序裁减 source/详情，并以 omitted=true/omittedSources 标明实际省略；不通过空 catch 丢弃后仍确认同步。不写入 prompt/history。source 晚到时只更新 metadata/version，不改变消息正文或排序。

### Terminal handling

收到 completed、error、失败、取消、异常 EOF、网络异常或本地 abort 后，前端将仍为 started 的活动标记 interrupted；配置响应 body 在 `response.json()` 阶段被取消时按 CODEX_GATEWAY_ABORTED 收束为 canceled，不能发送 Gateway 请求或提交副作用。重载时把本设备 running 回合变为 unknown 并结束其活动。catch 路径显式安排 Codex sync，覆盖零 assistant message 的失败/unknown 回合；只有整轮 completed 才调用既有 `commitCodexResponse`。

## Verification

使用本地 fake Gateway、合成 SSE 和现有 Node/browser VM 测试覆盖：旧协议、native/legacy 分流、跨块 SSE、activity/source 关联与晚到 source、URL 脱敏/恶意 HTML/非法事件、重复/超限、取消/错误/EOF、重载、metadata allowlist、零 message 终态同步、completed 副作用门槛、排序保护和 Render 原样转发。禁止真实模型、生产 Gateway、部署和云端写入。
