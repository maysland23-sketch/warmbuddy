# 前端模块化拆分 — 实施方案

> 生成时间：2026-08-02 | 状态：待确认

---

## 决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | Desire 模块触发逻辑 | 前端仅负责本地被动增长计算 + 后端同步，触发由后端 cron 完成 |
| 2 | Store 迁移策略 | 渐进式：模块内通过 AppCore 访问，未拆分代码保留直接访问 |
| 3 | onclick 兼容 | 全局兼容包装器 + @deprecated 标注，最后一步统一替换 |
| 4 | 边界模糊函数 | 只提取明确归属的，其余标注 @TODO 待归类，清理步骤集中处理 |
| 5 | MemoryModule 集成 | 不改动 memory.js，作为外部模块注册到 AppCore |
| 6 | Store 物理位置 | store/saveStore/loadStore 移入 app-core.js，index.html 保留全局引用 |
| 7 | Bug 处理 | 审查记录到 docs/bugs-found.md，拆分中不修复 |

---

## 一、完整文件清单

### 新建文件

| # | 文件 | 预估行数 | 说明 |
|---|------|---------|------|
| 1 | `public/js/app-core.js` | ~200 行 | 全局 store、saveStore/loadStore、register/getStore/updateStore/on/emit、init() 主流程 |
| 2 | `public/js/ui.js` | ~180 行 | 页面导航（navigate/goHome）、面板开关（toggleSettings/toggleProjectSidebar/openMemoryPanel/closeMemoryPanel）、模态框（showModal/closeModal）、toast、主题系统、closeAllPanels |
| 3 | `public/js/sync.js` | ~350 行 | 后端同步（syncProjectConfigToBackend、syncMessagesToBackend、scheduleMessageSync）、系统事件轮询（pollSystemEvents）、云端数据拉取（pollCloudData、reconcileFromBackend）、desire 状态同步（syncDesireStateToBackend）、pullAllProjectEnabledStates |
| 4 | `public/js/chat.js` | ~800 行 | sendMessage、triggerAIResponse、renderChatMessages、流式渲染、气泡交互（点击/长按/双击/touch）、草稿气泡、回复预览、批量星标、引用回复、消息删除 |
| 5 | `public/js/desire.js` | ~80 行 | 欲望值被动增长（updateDesireDrives）、欲望面板渲染 |
| 6 | `public/js/todo.js` | ~200 行 | 待办 CRUD（addTodo/saveTodo/toggleTodo/deleteTodo）、提醒检测（checkTodoReminders）、前后端同步（syncTodosToBackend/fetchTodosFromBackend） |
| 7 | `public/js/settings.js` | ~180 行 | API Key 管理、密码验证、模型切换、偏好设置、AI 名称、邮箱配置、主题、provider presets |

### 第三步清理时新建

| # | 文件 | 预估行数 | 说明 |
|---|------|---------|------|
| 8 | `public/js/litterbox.js` | ~150 行 | Litter box 全部逻辑 |
| 9 | `public/js/diary.js` | ~200 行 | 日记 CRUD、日历 |
| 10 | `public/js/backup.js` | ~120 行 | 数据导入导出 |

### 估算汇总

| 类别 | 行数 |
|------|------|
| 新建 7 个模块 | ~1,990 行 |
| 清理步骤 3 个模块 | ~470 行 |
| **总计新建** | **~2,460 行** |
| index.html 净减少 JS | ~6,500 行 → ~1,100 行（保留 HTML/CSS/加载/兼容包装器） |

---

## 二、每个模块的公开 API 列表

### 1. AppCore (`app-core.js`)

```javascript
var AppCore = (function() {
  return {
    // 初始化
    init: function(),                    // 主启动流程，依次调用各模块 init()

    // 模块注册
    register: function(name, module),    // 注册模块，按依赖顺序调用
    getModule: function(name),           // 获取已注册模块

    // Store 管理
    getStore: function(),                // 返回全局 store 对象引用
    updateStore: function(path, value),  // 通过点号路径更新 store（如 'projects[0].name'）
    saveStore: function(),               // 立即保存（绕过 debounce）
    loadStore: function(),               // 异步加载（Promise）

    // 事件总线
    on: function(event, callback),       // 订阅事件
    emit: function(event, data),         // 发布事件
    off: function(event, callback),      // 取消订阅

    // 工具
    gid: function(prefix),               // 唯一 ID 生成
  };
})();
```

### 2. UI (`ui.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 绑定底部导航点击、面板关闭事件 |
| `navigate(page)` | `string` | — | 切换页面（home/chat/bookshelf/diary） |
| `goHome()` | — | — | 回首页 |
| `closeAllPanels()` | — | — | 关闭所有侧面板和 overlay |
| `toggleSettings()` | — | — | 开关设置面板 |
| `toggleProjectSidebar()` | — | — | 开关项目侧栏 |
| `openMemoryPanel(tab)` | `string?` | — | 打开记忆面板（可选指定 tab） |
| `closeMemoryPanel()` | — | — | 关闭记忆面板 |
| `showModal(title, bodyHtml, actions)` | `string, string, array` | — | 通用模态框 |
| `closeModal()` | — | — | 关闭模态框 |
| `toast(msg)` | `string` | — | 轻提示 |
| `showStatusToast(msg)` | `string` | — | 长时间提示 |
| `renderPage(page)` | `string` | — | 委托渲染特定页面 |

### 3. Sync (`sync.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 启动所有定时器（轮询间隔） |
| `syncProjectConfigToBackend(updateChatTime)` | `bool?` | `Promise` | 推送项目配置到后端 |
| `syncMessagesToBackend()` | — | `Promise` | 批量同步消息到 Supabase |
| `scheduleMessageSync()` | — | — | 调度消息同步（debounce） |
| `pullAllProjectEnabledStates()` | — | `Promise` | 拉取所有项目的启用状态 |
| `reconcileFromBackend()` | — | `Promise` | 启动时从后端拉取最新 desire 状态 + 系统事件 |
| `pollCloudData(projectId)` | `string` | `Promise` | 轮询云端的 litter/diary 数据 |
| `syncDesireStateToBackend(force)` | `bool?` | `Promise` | 推送 desire 状态到后端 |
| `pollSystemEvents()` | — | `Promise` | 轮询系统事件 |
| `syncTodosToBackend()` | — | `Promise` | 同步 todos 到后端 |
| `fetchTodosFromBackend(projectId)` | `string` | `Promise` | 从后端拉取 todos |

### 4. Chat (`chat.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 绑定输入框事件、发送按钮、附件 |
| `sendMessage()` | — | `Promise` | 发送消息（主入口） |
| `triggerAIResponse(chat, userText, diaryIntent)` | `object, string, bool?` | `Promise` | 触发 AI 回复（流式） |
| `renderChatMessages(preserveScroll)` | `bool?` | — | 渲染当前对话的消息列表 |
| `renderProjectList()` | — | — | 渲染项目列表 |
| `selectProject(pid)` | `string` | — | 切换项目 |
| `selectChat(pid, cid)` | `string, string` | — | 切换对话 |
| `addChat(pid)` | `string` | — | 新建对话 |
| `addProject()` | — | — | 新建项目 |
| `saveProject()` | — | — | 保存项目名 |
| `startReply(msgId)` | `string` | — | 开始引用回复 |
| `cancelReply()` | — | — | 取消引用回复 |
| `handleBubbleClick(event, msgId, idx)` | `event, string, number` | — | 气泡点击 |
| `handleBubbleLongPress(msgId)` | `string` | — | 气泡长按 |
| `deleteBubble(idx)` | `number` | — | 删除消息 |
| `starBubble(idx)` | `number` | — | 星标消息 |
| `stageDraftBubble()` | — | — | 暂存草稿气泡 |

### 5. Desire (`desire.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 注册系统事件回调 |
| `updateDesireDrives(reflection)` | `object` | — | 根据 AI 反思更新欲望值 |
| `getDesireSystem()` | — | `object` | 获取当前欲望系统状态 |
| `getDriveLabel(key)` | `string` | `string` | 获取欲望中文标签 |

### 6. Todo (`todo.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 绑定 todo UI 事件 |
| `addTodo()` | — | — | 打开新增 todo 模态框 |
| `saveTodo()` | — | — | 保存新 todo |
| `toggleTodo(id)` | `string` | — | 切换完成状态 |
| `deleteTodo(id)` | `string` | — | 删除 todo |
| `switchTodoTab(tab, btn)` | `string, element` | — | 切换 short/long tab |
| `renderTodos()` | — | — | 渲染 todo 列表 |
| `checkTodoReminders()` | — | — | 检查提醒并触发 |
| `syncTodosToBackend()` | — | `Promise` | 同步到后端 |
| `fetchTodosFromBackend(projectId)` | `string` | `Promise` | 从后端拉取 |
| `openGoalDetail(id)` | `string` | — | 打开长期目标详情 |
| `saveGoalDetail()` | — | — | 保存长期目标详情 |

### 7. Settings (`settings.js`)

| 方法 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `init()` | — | — | 绑定设置页面事件 |
| `updateSettingsUI()` | — | — | 刷新设置面板 UI |
| `toggleAiSetting(key)` | `string` | — | 开关 AI 设置项 |
| `toggleDarkMode()` | — | — | 切换深色模式 |
| `showProjectApiModal(pid)` | `string?` | — | 打开 API 配置弹窗 |
| `saveProjectApiConfig(pid)` | `string` | — | 保存 API 配置 |
| `testProjectConnection(pid)` | `string` | `Promise` | 测试连接 |
| `showModelModal()` | — | — | 打开模型选择弹窗 |
| `setActiveModel(modelId)` | `string` | — | 设置当前模型 |
| `showAiNameModal()` | — | — | 打开 AI 名称编辑弹窗 |
| `saveAiName()` | — | — | 保存 AI 名称 |
| `showPreferenceModal()` | — | — | 打开偏好设置弹窗 |
| `savePreference()` | — | — | 保存偏好设置 |
| `showEmailConfigModal()` | — | — | 打开邮箱配置弹窗 |
| `saveEmailConfig()` | — | — | 保存邮箱配置 |
| `toggleEmailEnabled()` | — | — | 开关邮件 |
| `loadPresets()` | — | `Promise` | 加载远程 presets |

---

## 三、模块间依赖关系图

```
                        ┌──────────────┐
                        │   AppCore    │
                        │  (app-core)  │
                        │              │
                        │ store,       │
                        │ save/load,   │
                        │ register,    │
                        │ on/emit,     │
                        │ init()       │
                        └──┬───┬───┬──┘
                           │   │   │
          ┌────────────────┘   │   └────────────────┐
          ▼                    ▼                    ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │    UI    │        │   Sync   │        │ Memory   │
    │  (ui.js) │        │ (sync.js)│        │ (external)│
    │          │        │          │        │ memory.js│
    │ navigate │        │ poll     │        │          │
    │ panels   │        │ sync     │        │ load/save│
    │ modals   │        │ config   │        │ AEM/USM  │
    │ toast    │        │ events   │        │ search   │
    └────┬─────┘        └────┬─────┘        └──────────┘
         │                   │
         ▼                   ▼
    ┌──────────┐        ┌──────────┐
    │  Chat    │        │  Desire  │
    │ (chat.js)│        │(desire.js│
    │          │        │          │
    │ send     │        │ drives   │
    │ stream   │        │ growth   │
    │ bubbles  │        │ labels   │
    └──────────┘        └──────────┘
         │
         ▼
    ┌──────────┐        ┌──────────┐
    │   Todo   │        │ Settings │
    │ (todo.js)│        │(settings.│
    │          │        │   js)    │
    │ CRUD     │        │          │
    │ remind   │        │ api keys │
    │ sync     │        │ models   │
    └──────────┘        │ presets  │
                        │ email    │
                        └──────────┘
```

### 依赖关系说明

| 模块 | 依赖 | 通信方式 |
|------|------|---------|
| **AppCore** | 无 | 直接管理 store，协调所有模块 |
| **UI** | AppCore | 通过 AppCore 读写 store、emit 导航事件 |
| **Sync** | AppCore | 通过 AppCore 读写 store、emit 事件给 Chat/Desire/Todo |
| **Chat** | AppCore, Sync, UI | 通过 AppCore 事件总线获取 sync 数据、调用 UI 方法 |
| **Desire** | AppCore, Sync | 通过 AppCore 接收 Sync 的 poll 结果 |
| **Todo** | AppCore, Sync, UI | 通过 AppCore 获取 sync 数据、使用 UI 的 toast |
| **Settings** | AppCore, Sync, UI | 通过 AppCore 更新配置、触发 sync、使用 UI 的 modal |

### 加载顺序（`<script>` 标签）

```html
<script src="localforage.min.js"></script>
<script src="js/memory.js"></script>       <!-- 外部模块，最先加载 -->
<script src="js/app-core.js"></script>     <!-- 1st -->
<script src="js/ui.js"></script>           <!-- 2nd -->
<script src="js/sync.js"></script>         <!-- 3rd -->
<script src="js/chat.js"></script>         <!-- 4th (parallel with desire/todo/settings) -->
<script src="js/desire.js"></script>
<script src="js/todo.js"></script>
<script src="js/settings.js"></script>
<!-- index.html 残留脚本（含兼容包装器和待归类函数） -->
```

---

## 四、全局变量/函数迁移表

### 全局变量迁移

| 当前全局变量 | 迁移目标 | 位置 |
|-------------|---------|------|
| `store` (const) | `AppCore._store` (私有) + 兼容引用 | app-core.js |
| `_saveTimer` | `AppCore._saveTimer` | app-core.js |
| `nextTodoId` | `TodoModule._nextId` | todo.js |
| `currentMemoryTab` | 保留在 index.html (memory 面板相关，待归类) | index.html |
| `coreTabPage` | 保留在 index.html | index.html |
| `currentTokenFilter` | 保留在 index.html | index.html |
| `batchSelectMode`, `batchSelectedIds` | `ChatModule._batchMode`, `ChatModule._batchIds` | chat.js |
| `_dynCtxCache` | 保留在 index.html (待归类) | index.html |
| `pendingReply` | `ChatModule._pendingReply` | chat.js |
| `draftBubbles` | `ChatModule._draftBubbles` | chat.js |
| `draftEditorIdx` | `ChatModule._draftEditorIdx` | chat.js |
| `pendingImportData` | 保留在 index.html (待归类) | index.html |
| `contextMenuTarget` | 保留在 index.html | index.html |
| `bubbleTouchTimer`, `bubbleTouchMsgId` | `ChatModule._touchTimer`, `ChatModule._touchMsgId` | chat.js |
| `pushSubscribed` | 保留在 index.html (PWA 相关) | index.html |
| `_pushPermissionRequested` | 保留在 index.html (PWA 相关) | index.html |

### 关键全局函数迁移

| 函数 | 原行号 | 迁移目标 |
|------|--------|---------|
| `gid()` | 1106 | AppCore.gid() |
| `saveStore()` | 1229 | AppCore.saveStore() (私有 `_saveStore`) |
| `loadStore()` | 1259 | AppCore.loadStore() (私有 `_loadStore`) |
| `$()` | 2809 | AppCore.$() 或保留全局 |
| `navigate()` | 2868 | UIModule.navigate() |
| `goHome()` | 2876 | UIModule.goHome() |
| `closeAllPanels()` | 2879 | UIModule.closeAllPanels() |
| `toggleSettings()` | 2883 | UIModule.toggleSettings() |
| `toggleProjectSidebar()` | 2887 | UIModule.toggleProjectSidebar() |
| `openMemoryPanel()` | 2891 | UIModule.openMemoryPanel() |
| `closeMemoryPanel()` | 2895 | UIModule.closeMemoryPanel() |
| `showModal()` / `closeModal()` | 3390 / 3411 | UIModule.showModal() / closeModal() |
| `toast()` / `showStatusToast()` | 2863 / 2864 | UIModule.toast() / showStatusToast() |
| `syncProjectConfigToBackend()` | 7310 | SyncModule.syncProjectConfigToBackend() |
| `syncMessagesToBackend()` | 7365 | SyncModule.syncMessagesToBackend() |
| `pollSystemEvents()` | 7607 | SyncModule.pollSystemEvents() |
| `pollCloudData()` | 7508 | SyncModule.pollCloudData() |
| `syncDesireStateToBackend()` | 7552 | SyncModule.syncDesireStateToBackend() |
| `reconcileFromBackend()` | 7453 | SyncModule.reconcileFromBackend() |
| `sendMessage()` | 6818 | ChatModule.sendMessage() |
| `triggerAIResponse()` | 6021 | ChatModule.triggerAIResponse() |
| `renderChatMessages()` | 5341 | ChatModule.renderChatMessages() |
| `renderProjectList()` | 4253 | ChatModule.renderProjectList() |
| `selectProject()` | 4257 | ChatModule.selectProject() |
| `selectChat()` | 4258 | ChatModule.selectChat() |
| `startReply()` / `cancelReply()` | 5489 / 5505 | ChatModule.startReply() / cancelReply() |
| `handleBubbleClick()` | 5546 | ChatModule.handleBubbleClick() |
| `starBubble()` | 5888 | ChatModule.starBubble() |
| `deleteBubble()` | 5871 | ChatModule.deleteBubble() |
| 所有草稿气泡函数 | 6551-6816 | ChatModule.* |
| `updateDesireDrives()` | 2643 | DesireModule.updateDesireDrives() |
| `getDriveLabel()` | 2861 | DesireModule.getDriveLabel() |
| `getDesireSystem()` | 2853 | DesireModule.getDesireSystem() |
| `addTodo()` / `saveTodo()` / `toggleTodo()` / `deleteTodo()` | 3946-3937 | TodoModule.* |
| `renderTodos()` | 3881 | TodoModule.renderTodos() |
| `checkTodoReminders()` | 2705 | TodoModule.checkTodoReminders() |
| `switchTodoTab()` | 3876 | TodoModule.switchTodoTab() |
| `updateSettingsUI()` | 3696 | SettingsModule.updateSettingsUI() |
| `toggleAiSetting()` | 3716 | SettingsModule.toggleAiSetting() |
| `toggleDarkMode()` | 3775 | SettingsModule.toggleDarkMode() |
| `showProjectApiModal()` | 3513 | SettingsModule.showProjectApiModal() |
| `showModelModal()` | 3650 | SettingsModule.showModelModal() |
| `setActiveModel()` | 3841 | SettingsModule.setActiveModel() |
| `loadPresets()` | 3414 | SettingsModule.loadPresets() |
| `init()` | 8477 | AppCore.init() (逐步迁移内容) |

---

## 五、风险点评估

| 风险 | 影响 | 概率 | 防范措施 |
|------|------|------|---------|
| **模块加载顺序错误** | 页面白屏、JS 报错 | 中 | 严格控制 `<script>` 加载顺序；`AppCore` 中增加 `_loaded` 标记，未加载完成时不接受 register 调用；每步验证页面加载 |
| **全局函数被删除但 HTML onclick 仍引用** | 按钮点击无反应 | 中 | 拆分时保留全局兼容包装器（`@deprecated`）；全部拆分完成后统一替换为事件绑定；每步手动点击验证所有相关按钮 |
| **事件总线过度使用** | 性能下降、调用链难追踪 | 低 | 仅用于跨模块通信；模块内部保持直接函数调用；事件名枚举化，避免字符串散落 |
| **多个模块同时修改 store** | 数据不一致 | 低 | 所有写操作必须通过 `AppCore.updateStore()`；内部加 debounce 锁；`updateStore` 记录变更日志便于调试 |
| **旧 Service Worker 缓存旧 index.html** | 更新后用户仍看到旧版 | 中 | 更新 SW 版本号；增加 `skipWaiting` + `clients.claim`；部署后验证 SW 版本 |
| **Chat 模块过大（~800 行）导致维护困难** | 模块内部耦合 | 中 | Chat 模块内部按子功能分组注释（渲染/发送/气泡/草稿）；后续可进一步拆分 |
| **触发 AI 响应函数边界模糊** | 拆分不彻底导致残留 | 高 | `triggerAIResponse` 整体移入 Chat 模块；其调用的 memory/diary 钩子通过 AppCore 事件触发；保留一份原始代码备份 |

---

## 六、分步验证计划

### 第 1 步：创建 AppCore — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 页面加载 | 无白屏，控制台无 JS 报错 |
| Store 初始化 | `AppCore.getStore()` 返回正确数据（与拆分前一致） |
| save/load | 修改 store 后手动调用 `AppCore.saveStore()`，刷新页面数据持久 |
| 模块注册 | `AppCore.register('test', mockModule)` 后 `AppCore.getModule('test')` 返回正确 |
| 事件总线 | `AppCore.on('test', cb)` 后 `AppCore.emit('test', data)` 触发回调 |

### 第 2 步：提取 UI — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 底部导航 | 四个标签（home/chat/bookshelf/diary）点击切换正常 |
| 页面显示 | 每页内容正确渲染，无布局错乱 |
| 面板开关 | 设置面板、项目侧栏、记忆面板 打开/关闭正常 |
| 模态框 | `showModal(title, body, actions)` 弹出和关闭正常 |
| Toast | `toast('test')` 弹出 2 秒消失 |
| 主题 | 深色模式切换正常 |
| 兼容包装器 | 直接调用 `navigate('chat')` 等同于 `UIModule.navigate('chat')` |

### 第 3 步：提取 Sync — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 配置同步 | 修改设置后刷新页面，设置仍存在 |
| 消息同步 | 发送消息后刷新页面，消息仍在 |
| 系统事件 | `pollSystemEvents` 30s 轮询正常（控制台有日志） |
| 启动 reconcile | 页面首次加载后 desire 状态从后端恢复正确 |
| Todo 同步 | 添加 todo 后刷新页面，todo 仍在 |
| 模块间事件 | Sync 的 poll 结果通过 AppCore 事件正确传递 |

### 第 4 步：提取 Chat — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 发送消息 | 输入文字点发送，消息出现在聊天区 |
| AI 回复 | AI 正常返回流式回复，逐句显示 |
| 气泡点击 | 点击 AI 气泡弹出交互菜单 |
| 双击头像 | 双击 AI 头像触发戳一戳 |
| 引用回复 | 点击回复后发送，引用块正确显示 |
| 草稿气泡 | 暂存草稿，草稿列表显示，发送草稿 |
| 批量星标 | 长按进入批量模式，选择后确认星标 |
| 消息删除 | 删除气泡后消失 |
| 项目切换 | 切换项目/对话，聊天区更新 |
| 滚动 | 发送消息后自动滚到底部 |
| 兼容 | `onclick="sendMessage()"` 正常 |

### 第 5 步：提取 Desire — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 欲望值增长 | 对话后控制台有欲望值变化日志 |
| 欲望面板 | 在记忆面板的 desires tab 中正确显示驱动条 |
| 标签映射 | `getDriveLabel('resonance')` 返回 '共鸣欲' |
| 不与后端冲突 | `syncDesireStateToBackend` 推送的 desire 数据格式正确 |

### 第 6 步：提取 Todo — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 添加 todo | 点 + 按钮，填写后保存，列表中出现 |
| 完成 todo | 点击完成圆圈，todo 变灰/删除 |
| 删除 todo | 左滑删除 |
| Tab 切换 | short-term / goals 切换正常 |
| 长期目标 | 打开目标详情、编辑进度、保存 |
| 提醒触发 | `checkTodoReminders` 对到期 todo 正常触发 |
| 兼容 | `onclick="addTodo()"` 正常 |

### 第 7 步：提取 Settings — 验证

| 检查项 | 通过标准 |
|--------|---------|
| API Key | 打开弹窗、修改、保存、测试连接 |
| 模型切换 | 下拉选择模型后 setting 面板更新显示 |
| AI 名称 | 修改 AI 名称后聊天页显示更新 |
| AI 开关 | DateTime/Weather/Voice/Search 开关切换 |
| 偏好设置 | 打开、编辑、保存 preference |
| 邮箱配置 | 修改收件人/发件人、开关 |
| 深色模式 | 切换正常 |
| Presets | 远程 presets 加载、选择一个 preset 后 API 配置更新 |

### 第 8 步：最终全功能回归 — 验证

| 检查项 | 通过标准 |
|--------|---------|
| 聊天 | 发送/接收/流式/戳一戳/引用回复/草稿/批量星标 |
| 记忆 | 记忆面板各 tab 正常、搜索正常 |
| 待办 | 增删改查、提醒 |
| 日记 | 查看/新建/编辑/删除/回复 |
| 欲望 | 面板显示、被动增长 |
| 设置 | 所有设置项 |
| 导入导出 | 导出→导入数据一致 |
| 刷新 | 全状态持久化 |
| 控制台 | 无新增 JS 报错 |
| SW | Service Worker 正常注册和推送 |

---

## 七、拆分步骤执行顺序

| 步骤 | 内容 | 预估耗时 | 依赖 |
|------|------|---------|------|
| **前置** | 审查目标模块代码，记录 bug 到 `docs/bugs-found.md` | 30min | — |
| **第 1 步** | 创建 AppCore | 45min | 前置 |
| **第 2 步** | 提取 UI | 30min | 第 1 步 |
| **第 3 步** | 提取 Sync | 45min | 第 2 步 |
| **第 4 步** | 提取 Chat | 90min | 第 3 步 |
| **第 5 步** | 提取 Desire | 20min | 第 3 步 |
| **第 6 步** | 提取 Todo | 30min | 第 3 步 |
| **第 7 步** | 提取 Settings | 30min | 第 3 步 |
| **第 8 步** | 清理 + 最终回归 | 60min | 全部 |
| **后续** | litterbox/diary/backup 模块 + @TODO 函数归类 | TBD | 第 8 步 |
