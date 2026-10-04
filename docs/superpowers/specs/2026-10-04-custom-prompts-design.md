# 自定义提示词注入设计

**日期：** 2026-10-04  
**状态：** 已确认，待实施  
**范围：** 聊天窗口级开关和轮次调度；提示词定义仅保存在浏览器本地

## 1. 目标

在现有 Settings 中增加“自定义提示词”模块。用户可以保存多个提示词，并为每个提示词设置标题、正文和注入频率；提示词定义对所有项目和聊天窗口可用，但启用状态、轮次计数和注入计划只属于当前聊天窗口。

启用提示词后，下一次实际 AI 请求立即注入，之后按配置的每 X 次 AI 请求注入一次。提示词不写入可见聊天记录，不参与消息同步、滑动窗口、轮次摘要或记忆压缩。

## 2. 已确认的行为

- “窗口”指 WarmBuddy 内部的聊天窗口，不扩展浏览器 Tab 之间的实时同步。
- 一次实际发出的 AI 请求算一轮；本地 `/todo`、`/book`、`/litter` 等命令不计入。
- 默认频率为每 5 轮，最小值为 1。
- 重新开启提示词后，下一轮立即注入。
- 修改频率会重置为下一轮注入；修改标题或内容不重置计数。
- 删除提示词后立即停止所有窗口的后续注入，并清理对应状态。
- 每条正文最多 3000 个 Unicode 字符。
- 当前窗口所有已启用提示词的正文总长度最多 6000 个 Unicode 字符；超出时禁止开启。
- 普通 AI、Agent Gateway 和联网搜索二次请求都遵循提示词规则。
- 提示词定义和窗口状态使用现有本地 store 保存，并随现有导入导出备份。
- 启用时提示词会随请求发送给当前配置的模型服务；本地保存不代表不会离开浏览器。

## 3. 方案选择

### 3.1 采用方案

增加独立的 `CustomPromptModule`，负责提示词定义、窗口状态、数据清洗、调度和 Settings 列表渲染；继续复用 `AppCore` 的 store 和 localForage/localStorage 降级机制。

聊天模块只通过一个窄接口请求当前轮次的注入内容。这样轮次计数和调度规则集中在一个模块中，Settings 不需要了解上下文拼装细节，Chat 也不需要了解存储格式。

### 3.2 未采用方案

- 不把调度和 CRUD 直接散落到 `settings.js`、`chat.js` 的多个调用点，避免状态规则重复。
- 不把提示词作为 `chat.messages` 中的 system 消息保存，避免污染 UI、云端同步、轮次分组和摘要压缩。
- 不新增后端提示词存储或同步接口，避免超出“本地保存”范围并扩大隐私面。
- 不新增第三方依赖或改造现有前端架构。

## 4. 数据模型

### 4.1 全局提示词定义

在 `AppCore` store 中增加：

```js
customPrompts: [
  {
    id: 'cp_xxx',
    title: '可选标题',
    content: '提示词正文\\n支持换行',
    interval: 5,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z'
  }
]
```

正文保存原始换行和格式。保存时只使用 `trim()` 判断是否为空，不删除用户实际输入的前后空白。

### 4.2 聊天窗口状态

每个 chat 增加：

```js
customPromptRound: 0,
customPromptStates: {
  cp_xxx: {
    enabled: true,
    nextRound: 6
  }
}
```

`customPromptRound` 只由 `CustomPromptModule.beginAiRound(chat)` 增加。`nextRound` 是该提示词下一次允许注入的 AI 请求轮次。缺少状态的提示词视为关闭，不自动开启。

新窗口和迁移后的旧窗口均使用关闭状态和空计数；不会继承其他窗口的启用状态。

## 5. 调度与注入流程

`CustomPromptModule` 对外提供：

```js
beginAiRound(chat) -> {
  roundNumber: number,
  content: string,
  injectedIds: string[]
}
```

调用规则：

1. `sendMessage()` 先处理本地命令；只有进入 `triggerAIResponse()` 才调用 `beginAiRound()`。
2. `beginAiRound()` 将当前窗口轮次加一。
3. 选择 `enabled === true && roundNumber >= nextRound` 的提示词。
4. 为每个被选中的提示词设置 `nextRound = roundNumber + interval`。
5. 返回合并后的 system context。
6. 返回值用于初始 AI 请求和同一轮的联网搜索二次请求，不重复调用调度器。

因此，提示词在开启后的注入轮次为 `1、1+X、1+2X...`。请求已经发出但返回错误时仍算一轮；未进入 AI 请求流程的本地命令不算。

提示词按全局定义数组顺序稳定拼接：

```text
【自定义提示词开始】
标题：可选标题
原始正文
【自定义提示词结束】
```

标题和外层标识不改变正文内容。多个到期提示词之间使用两个换行分隔。

## 6. 上下文和模型兼容

前端仍保留现有静态提示词、动态上下文、共享日记、消息 ID、摘要和最近 6 轮消息的结构。自定义提示词作为额外 system context 加入，不进入滑动窗口历史。

后端 `server.js` 的 Anthropic 请求转换必须从“读取第一个 system 消息”改为“合并所有 system 消息”，以保证当前已有动态上下文和新增提示词都不会丢失：

```js
const systemContent = messages
  .filter(m => m.role === 'system')
  .map(m => typeof m.content === 'string' ? m.content : '')
  .filter(Boolean)
  .join('\n\n');
```

OpenAI-compatible 路径继续发送多个 system 消息；Agent Gateway 的 canonical serializer 已经会保留所有消息内容。

## 7. Settings 界面

在现有 AI 功能区域增加“自定义提示词”组：

- 隐私说明。
- “新建提示词”按钮。
- 每条提示词显示标题、正文预览和 `每 X 轮`。
- 当前聊天窗口的独立开关。
- 编辑和删除操作。

编辑弹窗使用现有 `UIModule.showModal()`：

- 标题：可选，界面限制 80 个 Unicode 字符。
- 内容：必填，`textarea`，最多 3000 个 Unicode 字符。
- 频率：数字输入，`min=1`，默认 5。

所有列表内容先经过 `AppCore.escapeHtml()`；正文只在请求 payload 中以原始文本发送，不作为 HTML 渲染。

启用开关只修改当前 `store.activeChat` 对应的 `customPromptStates`。如果当前启用内容总长超过 6000 个 Unicode 字符，阻止开启并显示提示，不静默截断其他提示词。

## 8. 存储、迁移和容错

`migrateStoreAsync()` 增加自定义提示词迁移：

- `customPrompts` 非数组时恢复为空数组。
- 无效 id、非字符串正文、空正文记录被忽略。
- 正文按 3000 字符截断；频率小于 1 时修正为 1；缺失频率使用 5。
- 缺失时间字段补当前时间。
- 每个 chat 缺失 `customPromptRound` 或 `customPromptStates` 时补默认值。
- 清理引用不存在提示词的窗口状态。
- 不因单条坏记录丢弃整个 store。

CRUD 在变更 store 前完成输入验证。保存继续调用 `AppCore.saveStore()`，由现有 localForage → localStorage 降级策略处理配额问题；写入失败不抛出未处理异常，并通过已有 toast/console 路径提示。由于提示词有单条和总量上限，不额外创建第二套存储源。

提示词位于 `warmbuddy-store` 内，因此现有 BackupModule 的导入导出自动包含定义和窗口状态。导入后的 migration 负责再次清洗。

## 9. 模块接口和文件职责

新增 `public/js/custom-prompts.js`，注册 `customPrompts` 模块，公开：

```js
init()
getDefinitions()
renderSettings()
showEditor(promptId)
saveEditor()
toggleForActiveChat(promptId, enabled)
deleteDefinition(promptId)
beginAiRound(chat)
normalizeStore()
```

文件修改职责：

- `public/js/app-core.js`：store 默认字段、migration 和窗口默认字段。
- `public/index.html`：Settings HTML、提示词模块脚本加载。
- `public/js/settings.js`：调用模块渲染列表，并在 Settings 刷新时重绘。
- `public/js/ui.js`：分发新增的 Settings 操作。
- `public/js/chat.js`：在 AI 请求轮次开始时调用调度接口，并在搜索二次请求复用返回值。
- `server.js`：合并 Anthropic system 内容。
- `test/custom-prompts.test.js`：提示词模块纯逻辑和容错测试。
- 现有后端测试文件：增加多 system 消息保留的回归测试。

脚本加载顺序为 `app-core.js`、`ui.js`、`custom-prompts.js`、`chat.js`、`settings.js`，保证模块依赖可用。

## 10. 测试与验收

必须覆盖：

- 新建提示词默认频率为 5。
- 下一次 AI 请求立即注入。
- 每 X 轮注入一次。
- 多窗口计数独立。
- 关闭后立即停止。
- 重新开启立即从下一轮开始。
- 修改频率重置计划，修改内容不重置计划。
- 删除后所有窗口停止注入。
- 本地命令不增加提示词轮次。
- 批量草稿的一次 AI 请求只增加一轮。
- 3000 字限制和 6000 字窗口总量限制。
- 损坏 store 数据不会导致初始化失败。
- 正文换行在 payload 中保持不变。
- Anthropic 请求保留所有 system 内容。
- 现有全量测试继续通过。

验收标准：

1. Settings 中可以新增、编辑、删除和切换提示词。
2. 新增提示词不会自动影响任何聊天窗口。
3. 开启后下一次 AI 请求能观察到原始提示词内容。
4. 关闭后新的请求中不再出现该提示词。
5. 滑动窗口和聊天 UI 不出现自定义提示词伪消息。
6. 刷新、导出导入后提示词定义和窗口状态保持正确。
7. localForage/localStorage 异常、非法数据和配额失败不会造成未处理异常或整库清空。

## 11. 不在本轮处理

- 浏览器多个 Tab 的实时同步。
- 后端或云端同步自定义提示词。
- 提示词版本历史、排序拖拽和分类标签。
- Markdown 富文本预览；当前仅保留换行和原始文本格式。
- 对用户自定义内容进行语义审查或自动改写。
