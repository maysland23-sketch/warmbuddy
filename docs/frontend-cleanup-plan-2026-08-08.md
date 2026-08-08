# 前端模板拆分 — 最终清理实施方案

> **日期**：2026-08-08
> **目标**：完成前端代码拆分的最终清理，消除所有遗留风险
> **来源**：`前端代码拆分的最终清理.md` + 2026-08-02 完成记录 + 讨论确认

---

## 决策汇总

| 决策项 | 结论 |
|--------|------|
| 记忆相关函数归属 | 全部归入现有 `memory.js`（~1200 行新增） |
| risk5 范围 | chat.js 中所有对 index.html 全局函数的调用（6 个→实际更多） |
| 风险5与风险1关系 | 交叉处理：先迁移函数体到目标模块→再改 chat.js 调用 |
| `maybeAddMemory` / `maybeAICommentOnDiary` | 从 chat.js 提取到 memory.js / diary.js |
| onclick→data-action | 每拆一个模块同步清理该模块内 onclick（方案 B） |
| `getDynamicCtxFingerprint` | → app-core.js |
| `triggerExport` / `checkWeeklyAutoExport` | → backup.js |
| `generateLitterThought` 系列 | → litterbox.js |
| init 迁移 | 两步走：先 wrapper 后直接调用 |
| intervals | 归入 AppCore 管理 |

---

## 实施步骤

### 第 0 步：准备与基线验证

**操作**：
- 启动项目 `node server.js`，确认 `http://localhost:3000/?pwd=mays2026` 正常加载
- 在浏览器控制台执行：`AppCore.getStore()` / `AppCore.getModule('ui')` 确认模块系统正常
- 记录控制台现有 warning/error 作为基线
- 发送一条测试消息，确认 AI 回复正常
- Git 保存当前状态作为回退点

**验证标准**：全功能正常，控制台无新增报错

---

### 第 1 步：扩展 memory.js — 记忆逻辑函数迁移 ⚠️ 风险 5-P0

**迁移函数清单**（从 index.html 提取到 memory.js）：

| 原函数名 | 新方法名 | 行数 |
|----------|---------|------|
| `checkLongTermMemory(chat)` | `checkLongTerm(chat)` | ~80行 |
| `checkSummarization(chat)` | `checkSummarization(chat)` | ~20行 |
| `applyForgettingCurve()` | `applyForgettingCurve()` | ~20行 |
| `maybeAddMemory(ut, at)` | `maybeAdd(ut, at)` [从 chat.js 提取] | ~15行 |
| `getDynamicCtxFingerprint()` | → app-core.js `getCtxFingerprint()` | ~20行 |
| `unifiedSearch(query)` | `unifiedSearch(query)` | ~40行 |
| `searchByBM25(query)` | `searchByBM25(query)` | ~30行 |
| `searchByAffect(queryLabels)` | `searchByAffect(queryLabels)` | ~20行 |
| `searchBySemanticKey(queryKeywords)` | `searchBySemanticKey(queryKeywords)` | ~20行 |
| `rebuildBM25Index()` | `rebuildBM25Index()` | ~30行 |
| `tokenizeChinese(text)` | `tokenizeChinese(text)` | ~25行 |
| `bigramOverlap(a,b)` | `bigramOverlap(a,b)` | ~10行 |
| `isNearDuplicate(content, proj)` | `isNearDuplicate(content, proj)` | ~15行 |
| `isWeekBoundary(mem, proj)` | `isWeekBoundary(mem, proj)` | ~10行 |
| `createAEMFromMarkers(...)` | `createAEMFromMarkers(...)` | ~20行 |
| `queueQuietPresenceCoreMemory(...)` | `queueQuietPresence(...)` | ~55行 |
| `updateRelationalPortrait(...)` | `updateRelationalPortrait(...)` | ~25行 |
| `getDefaultStrategy(label)` | `getDefaultStrategy(label)` | ~13行 |
| `queuePortraitRefinement()` | `queuePortraitRefinement()` | ~70行 |
| `groupMessagesIntoRounds(msgs)` | `groupMessagesIntoRounds(msgs)` | ~25行 |
| `queueRoundCompression(chat, rounds)` | `queueRoundCompression(chat, rounds)` | ~60行 |
| `summarizeMessages(batch, ...)` | `summarizeMessages(batch, ...)` | ~70行 |
| `evictOldestCoreMemories()` | `evictOldestCoreMemories()` | ~10行 |
| `checkDeriveInsightsTrigger(source)` | `checkDeriveInsightsTrigger(source)` | ~15行 |
| `deriveRelationalInsights()` | `deriveRelationalInsights()` | ~180行 |
| `ensureColdStartPatterns()` | `ensureColdStartPatterns()` | ~25行 |
| `diffPatterns(old, new)` | `diffPatterns(old, new)` | ~15行 |
| `deduplicateById(arr)` | `deduplicateById(arr)` | ~10行 |

**审前 bug 检查**：
- `deriveRelationalInsights` 已有空值守卫修复（2026-08-02 修复1）
- `queuePortraitRefinement` 内嵌了 LLM 调用的 prompt 模板→ 审查是否有硬编码问题
- `summarizeMessages` 内嵌了 LLM 调用→ 审查异常处理是否完善

**风险**：
- `checkLongTermMemory` / `summarizeMessages` / `deriveRelationalInsights` 都调用后端 API，迁移后必须确保 `AppCore.BACKEND_URL` 可访问
- `memory.js` 从 994 行增长到 ~2200 行

**改 chat.js 调用**（6 处）：
```javascript
// chat.js:2298-2303 改为：
AppCore.getModule('memory').maybeAdd(userText, fullResponse);
// triggerLitterBox 暂不改(第2步处理)
AppCore.getModule('diary').maybeComment(fullResponse);  // 第3步处理
AppCore.getModule('memory').applyForgettingCurve();
AppCore.getModule('memory').checkSummarization(chat);
AppCore.getModule('memory').checkLongTerm(chat);
```

**验证标准**：
- 发送消息→AI 回复正常→记忆面板有新 AEM 条目
- `AppCore.getModule('memory').checkLongTerm(chat)` 控制台可调用
- 无 `ReferenceError: xxx is not defined`

---

### 第 2 步：创建 litterbox.js — 猫砂盆模块 ⚠️ 风险 5-P1

**新建文件**：`public/js/litterbox.js`

**迁移函数**（从 index.html 提取）：
- `renderLitter()`、`shakeLitterBox()`、`dismissLitterThought()`
- `triggerLitterBox(ut, at)` — 核心触发逻辑
- `getNextLitterType(chat)`、`countTodayLitter()`
- `validateLitterContent(text)`、`detectLitterSignals(userText, prevUserMsg)`
- `generateLitterThought(triggerSignals, userText)`
- 常量：`LITTER_THOUGHT_TYPES`、`LITTER_MAX_PER_DAY`、`LITTER_COOLDOWN_MS`、`LITTER_TYPE_LABELS`

**公开 API**：
```javascript
{
  init: function() { /* 绑定事件 */ },
  trigger: function(userText, aiResponse) { /* 入口 */ },
  render: function() { /* 渲染首页猫砂盆 */ },
  shake: function() { /* 抖落猫砂 */ },
  getItems: function() { /* 获取所有猫砂想法 */ }
}
```

**审前 bug 检查**：
- `shakeLitterBox()` 使用 `void icon.offsetWidth` 触发 reflow——CSS 动画 hack，不建议改动
- `generateLitterThought` 调用后端 LLM API——审查超时和错误处理
- `dismissLitterThought` 中 `_dismissedLitterIds` 数组可能无限增长（已有 100 上限保护）

**风险**：
- `triggerLitterBox` 是 chat.js 中直接被调用的函数，迁移后必须确保调用路径通畅
- `generateLitterThought` 依赖 `getActiveApiConfig()`、`getActiveChatObj()`——这些通过 AppCore 访问

**改 chat.js 调用**：
```javascript
// chat.js:2299 改为：
var lb = AppCore.getModule('litterbox');
if (lb && lb.trigger) lb.trigger(userText, fullResponse);
```

**同步清理 onclick→data-action**：`dismissLitterThought` 模板中的 `onclick` 改为 `data-action`

**在 index.html 中添加**：`<script src="js/litterbox.js"></script>`（位于 settings.js 之后）

**验证标准**：
- 发送消息后→控制台查看 AI 是否触发了猫砂盆
- 首页猫砂盆图标正常渲染
- 抖落猫砂盆动画正常

---

### 第 3 步：创建 diary.js — 日记 + 日历模块

**新建文件**：`public/js/diary.js`

**迁移函数**：
- 从 index.html：`renderDiary()`、`addDiaryEntry()`、`saveDiaryEntry()`、
  `editDiaryEntry()`、`confirmDeleteDiaryEntry()`、`saveDiaryEdit()`、
  `addDiaryReply()`、`toggleReplyAuthor()`、`saveDiaryReply()`、
  `selectMoodInModal()`、`navigateToDiaryReplySource()`、`getChatDisplayName()`
- 从 index.html（日历）：`openCalendar()`、`closeCalendar()`、`renderCalendar()`、
  `navCalendar()`、`genCalendarDays()`、`goToDiaryDate()`
- 从 chat.js（提取）：`maybeAICommentOnDiary(aiResponse)` → 公开方法 `maybeComment(aiResponse)`

**公开 API**：
```javascript
{
  init: function() {},
  render: function() {},
  addEntry: function() {},
  saveEntry: function() {},
  addReply: function(entryId) {},
  saveReply: function() {},
  maybeComment: function(aiResponse) {},
  openCalendar: function() {},
  renderCalendar: function() {}
}
```

**审前 bug 检查**：
- `renderDiary()` 模板中 `onclick` 残留：`editDiaryEntry`、`addDiaryReply`、`navigateToDiaryReplySource`→ 本步同步改为 data-action
- `saveDiaryReply()` / `saveDiaryEntry()` 中有对 `store.diarySelectedDate` 的依赖→ 在 diary.js 中通过 `AppCore.getStore()` 访问

**风险**：
- 日记是首页四个标签之一，渲染错误影响面大
- 日历叠加层（`calendarOverlay`）的关闭逻辑使用 `event.target` 判断→ 需确保迁移后引用正确

**改 chat.js 调用**：
```javascript
// chat.js:2300 改为：
var diary = AppCore.getModule('diary');
if (diary && diary.maybeComment) diary.maybeComment(fullResponse);
```

**在 index.html 中添加**：`<script src="js/diary.js"></script>`

**验证标准**：
- 切换到底部"日记"标签→日记列表正常渲染
- 新增日记→保存→重新渲染
- 日历选择日期→跳转正确日期日记
- 发送消息后→AI 可能对日记自动评论

---

### 第 4 步：创建 bookshelf.js — 书架 + 高亮模块

**新建文件**：`public/js/bookshelf.js`

**迁移函数**：
- `renderBookshelf()`、`renderReadingNote()`、`renderBookGrid()`
- `openBookDetail(bid)`、`deleteBook(bid,title)`、`confirmDeleteBook()`、`closeBookDetail(event)`
- `addHighlight(bid)`、`saveHighlight()`
- `askAIAboutNote(bid,nid)`、`doSubmitAskAI()`、`submitAskAI()`
- `navToChatSource(cid,pn)`
- `showBookshelfAddMenu()`、`saveBook()`

**公开 API**：
```javascript
{
  init: function() {},
  render: function() {},
  openBook: function(id) {},
  deleteBook: function(id, title) {},
  addHighlight: function(bid) {},
  askAI: function(bid, nid) {}
}
```

**审前 bug 检查**：
- `openBookDetail` 模板中有大量 onclick（`deleteBook`、`closeBookDetail`、`addHighlight`、`askAIAboutNote`）→ 本步同步改为 data-action
- `doSubmitAskAI` 和 `submitAskAI` 有大量重复代码（~80% 相同）→ 本次**只记录不修复**（只拆不改原则）
- 内嵌模板字符串使用 `escapeHtml`→ 确认 `AppCore.escapeHtml` 可访问

**风险**：
- 书籍删除确认模态框链式调用（`confirmDeleteBook` → `closeBookDetail` → `renderBookshelf`）→ 确保回调链不中断

**在 index.html 中添加**：`<script src="js/bookshelf.js"></script>`

**验证标准**：
- 书架列表正常渲染
- 添加书籍→正常出现
- 打开书籍详情→划线、笔记正常
- Ask AI 功能正常

---

### 第 5 步：创建 backup.js — 数据导入导出模块

**新建文件**：`public/js/backup.js`

**迁移函数**：
- `exportAllData()`、`importAllData()`、`executeImport()`、`clearAllData()`
- `handleMemoryImport(event)`、`importMemoriesJSON(data)`
- `triggerExport(chatId, type)`（约50行记忆导出）、`checkWeeklyAutoExport()`

**公开 API**：
```javascript
{
  init: function() {},
  exportData: function() {},
  importData: function() {},
  clearAll: function() {},
  triggerExport: function(chatId, type) {},
  checkWeeklyExport: function() {}
}
```

**审前 bug 检查**：
- `executeImport` 中 `_importLock` 标志用于阻止 saveStore 在 reload 窗口期写入→ 确认此标志在 app-core.js 中正确使用
- `clearAllData` 硬编码默认项目结构→ 确保与 app-core.js 中的初始化逻辑一致
- `importAllData` 用 `document.createElement('input')` 动态创建文件选择器→ 无 bug

**风险**：
- 数据导入会 `location.reload()`——这是设计行为，迁移后路径不能变
- `triggerExport` 依赖 `MemoryModule.getCML`、`getDerivedPatterns`、`getPersonalityProfiles`→ 这些都已通过 AppCore/模块可访问

**在 index.html 中添加**：`<script src="js/backup.js"></script>`

**验证标准**：
- 导出数据→下载 JSON 文件
- 导入数据→确认弹窗→刷新页面→数据恢复
- 清除数据→确认弹窗→数据清空
- 周一自动导出正常触发（需调整系统时间测试）

---

### 第 6 步：创建 email.js — 邮件模块

**新建文件**：`public/js/email.js`

**迁移函数**：
- `showEmailConfigModal()`、`saveEmailConfig()`
- `toggleEmailEnabled()`、`updateEmailSettingsUI()`
- `extractEmailFromResponse(text)`
- `handleEmailSend(chat, subject, body)`

**公开 API**：
```javascript
{
  init: function() {},
  showConfig: function() {},
  saveConfig: function() {},
  toggleEnabled: function() {},
  updateUI: function() {},
  extractFromResponse: function(text) {},
  send: function(chat, subject, body) {}
}
```

**审前 bug 检查**：
- `handleEmailSend` 中使用了 `chat.messages` 遍历构建历史消息→ 确认 chat 对象的 messages 数组结构不变
- `updateEmailSettingsUI` fetch `/api/email/status` 异步更新→ 无 bug

**风险**：
- 邮件发送依赖后端 Resend API→ 确保后端正常运行

**在 index.html 中添加**：`<script src="js/email.js"></script>`

**验证标准**：
- 打开邮件配置面板→正常显示
- 切换邮件开关→状态更新

---

### 第 7 步：创建 weather.js — 天气模块

**新建文件**：`public/js/weather.js`

**迁移函数**：
- `fetchWeather()`、`doWeatherFetch(lat, lon)`

**公开 API**：
```javascript
{
  init: function() {},
  fetch: function() {},
  getWeather: function() { return AppCore.getStore().weather; }
}
```

**审前 bug 检查**：
- `fetchWeather` 使用 `navigator.geolocation.getCurrentPosition`→ 已在之前的 session 验证过，无 bug

**风险**：
- 天气数据写入 `store.weather`→ chat.js 的 `buildDynamicContextBlock` 读取此字段，确保路径一致

**在 index.html 中添加**：`<script src="js/weather.js"></script>`

**验证标准**：
- 启动后天气自动获取
- 聊天中动态上下文块包含天气信息

---

### 第 8 步：创建 pwa.js — PWA + Push 模块

**新建文件**：`public/js/pwa.js`

**迁移函数**：
- `registerServiceWorker()`、`requestPushPermission()`
- `sendSubscriptionToServer(subscription)`、`urlBase64ToUint8Array(base64String)`
- `sendPushNotification(title, body, opts)`
- 相关变量：`pushSubscribed`、`_pushPermissionRequested`

**公开 API**：
```javascript
{
  init: function() {},
  registerSW: function() {},
  requestPush: function() {},
  sendNotification: function(title, body, opts) {}
}
```

**审前 bug 检查**：
- `requestPushPermission` 有 `PushManager` 可用性检查→ 已处理
- `sendSubscriptionToServer` fire-and-forget 无错误提示→ 无 bug（设计如此）
- `document.addEventListener('click', ...)` 只触发一次（`{once:true}`）→ 需要迁移到 PWA 模块的 init 中

**风险**：
- SW 注册失败会静默忽略→ 不影响主功能
- Push 权限请求绑定在首次用户点击上→ 迁移后确保事件监听器正确绑定

**在 index.html 中添加**：`<script src="js/pwa.js"></script>`

**验证标准**：
- `Application → Service Workers` 中看到 SW 已注册
- 首次点击页面→2秒后自动弹出通知权限请求

---

### 第 9 步：创建 artifacts.js — 文件附件 + Artifact 模块

**新建文件**：`public/js/artifacts.js`

**迁移函数**：
- `handleFileImport(event)` [chat 文件附件]、`handleChatFileAttach(event)`
- `renderFileAttachmentPreview()`、`removePendingFile(fid)`
- `injectArtifactMarkers(text)`、`extractArtifactsFromText(text)`
- `isGeneratingArtifact(text)`、`resolveArtifactRefs(text)`
- `openArtifactById(id)`、`closeArtifactViewer()`
- `downloadArtifact()`、`openArtifactNewTab()`、`deleteArtifact(id)`
- `dataURItoBlob(dataURI, mimeType)`
- 变量：`currentArtifactId`

**公开 API**：
```javascript
{
  init: function() {},
  injectMarkers: function(text) {},
  extractFromText: function(text) {},
  resolveRefs: function(text) {},
  openViewer: function(id) {},
  closeViewer: function() {},
  renderPreview: function() {}
}
```

**审前 bug 检查**：
- `extractArtifactsFromText` 中使用了 `sandbox="allow-scripts"` 的 iframe srcdoc→ 已在 git commit f3a8729 中修复过安全问题
- `dataURItoBlob` 处理 data URI 和普通文本→ 逻辑正确

**风险**：
- Artifact 渲染涉及 iframe→ 迁移后确保 HTML 模板中的 `artifactOverlay` 元素仍正确引用

**在 index.html 中添加**：`<script src="js/artifacts.js"></script>`

**验证标准**：
- 附加文件→预览显示
- AI 生成 HTML artifact→内联渲染→点击放大查看
- 下载 artifact 正常

---

### 第 10 步：扩展 app-core.js — Token 日志 + 初始化

**迁移到 app-core.js**：
- `logTokenCall(windowId, actionType, inputTokens, outputTokens, cacheRead, cacheWrite, model)`
- `pullProactiveTokenLogs()`
- `resetDailyTokensIfNeeded()`
- `getDynamicCtxFingerprint()` → `getCtxFingerprint()`
- `checkWeeklyMemoryWrite()` + `flushEvictedMessages()`
- `init()` + 所有 setInterval 调用

**init 迁移（两步走）**：
1. 先创建 `AppCore.init = function() { /* 完整 init 逻辑 */ }`，index.html 中保留 `function init() { AppCore.init(); }`
2. 验证稳定后，删除 index.html 的 wrapper

**intervals 管理**：
```javascript
AppCore._intervals = [];
AppCore._addInterval = function(fn, ms) {
  this._intervals.push(setInterval(fn, ms));
};
AppCore.clearAllIntervals = function() {
  this._intervals.forEach(clearInterval);
  this._intervals = [];
};
```

**审前 bug 检查**：
- `logTokenCall` 对 `store.tokenLogs[windowId]` 做了空值守卫→ 已处理
- `pullProactiveTokenLogs` 去重检查使用 `_tokenLogId`→ 逻辑正确
- `flushEvictedMessages` 写 memory 文件→ 依赖 `MemoryModule` 的保存机制

**风险（最高）**：
- init 是启动入口→ 任何改动都可能导致白屏
- setInterval 的 `this` 绑定→ IIFE 内使用 `AppCore._addInterval(function(){...}, ms)`

**验证标准**：
- 页面加载无白屏→全功能正常
- `AppCore.clearAllIntervals()` 可正常停止所有定时器
- `AppCore.getCtxFingerprint()` 返回有效指纹

---

### 第 11 步：内存文件 IO 包装器清理

**删除 index.html 中的**：
- `loadMemoryFilesForAllProjects()` — 调用 `MemoryModule.load()`
- `flushMemoryFile()` — 调用 `MemoryModule.save()`
- `readMemoryFile()` — 调用 `localforage.getItem()`
- `writeMemoryFile()` — 调用 `MemoryModule.save()`
- `syncProjectMemories()` — 调用 `MemoryModule.load()`
- `diffPatterns()` — 已迁移到 memory.js
- `deduplicateById()` — 已迁移到 memory.js

**同时搜索并替换所有对这些函数的调用处**→ 改为直接调用 MemoryModule。

---

### 第 12 步：风险 3 — onclick → data-action 收尾

> 注意：大部分 onclick 已在第 1-9 步模块迁移过程中同步清理。本步只处理遗留。

**检查清单**：
- [ ] 搜索 `index.html` 和所有 `public/js/*.js` 中模板字符串内的 `onclick="`
- [ ] 确认全部替换为 `data-action="xxx"` + `data-args="xxx"` 格式
- [ ] 确认 `ui.js` 的 event delegate switch 中已覆盖所有新增 action
- [ ] 引号转义验证：反引号模板中 data-args 使用单引号

**验证**：点击所有通过模板生成的按钮（项目列表、记忆面板、猫砂盆等），确认事件正常触发。

---

### 第 13 步：风险 2 — 轻型包装器消除

**消除清单（43 个包装器）**：

搜索项目中所有调用处，替换为直接模块调用：

| 包装器 | 替换为 |
|--------|--------|
| `toast(msg)` | `UIModule.toast(msg)` |
| `showModal(...)` | `UIModule.showModal(...)` |
| `closeModal()` | `UIModule.closeModal()` |
| `saveStore()` | `AppCore.saveStore()` |
| `gid(p)` | `AppCore.gid(p)` |
| `$(id)` | `AppCore.$(id)` |
| `navigate(p)` | `UIModule.navigate(p)` |
| ... 等 43 个 | ... |

执行方式：逐个模块文件替换，每替换完一个文件立即验证。

---

### 第 14 步：风险 4 — SW 版本号自动化

**修改 `public/service-worker.js`**：
```javascript
// 旧：var CACHE_NAME = 'warmbuddy-v7';
// 新：
var CACHE_NAME = 'warmbuddy-v' + Date.now();
```

确认 `install` 事件中 `self.skipWaiting()` 和 `activate` 事件中 `clients.claim()` 已存在。

**验证**：DevTools → Application → Service Workers → 查看版本号。

---

### 第 15 步：最终清理 & 全功能回归

**清理 index.html**：
- [ ] 删除所有已迁移的函数定义
- [ ] 删除所有已消除的包装器
- [ ] 保留：HTML 模板、CSS 样式、`<script>` 加载标签
- [ ] 删除 `BACKEND_URL`、`VAPID_PUBLIC_KEY`、`USER_NAME` 等全局常量包装器

**全功能回归测试**：
- [ ] 页面首次加载无白屏、无报错
- [ ] 发送消息 + AI 回复正常
- [ ] 戳一戳功能正常
- [ ] 记忆面板正常渲染和交互
- [ ] 猫砂盆功能正常
- [ ] 日记功能正常（含日历）
- [ ] 书架功能正常（含高亮、Ask AI）
- [ ] 数据导入导出正常
- [ ] 邮件发送功能正常
- [ ] 天气功能正常
- [ ] 底部导航切换正常
- [ ] 项目/窗口切换正常
- [ ] 关闭页面再重新打开，无报错
- [ ] index.html 中仅保留 HTML 模板、CSS、`<script>` 加载标签
- [ ] 全局作用域中无业务函数残留

---

## 预估工作量

| 步骤 | 内容 | 预估时间 | 风险等级 |
|------|------|---------|---------|
| 0 | 准备与基线 | 10 min | 低 |
| 1 | memory.js 扩展 + chat.js 调用改写 | 90 min | **高** |
| 2 | litterbox.js | 45 min | 中 |
| 3 | diary.js | 45 min | 中 |
| 4 | bookshelf.js | 30 min | 低 |
| 5 | backup.js | 30 min | 中 |
| 6 | email.js | 20 min | 低 |
| 7 | weather.js | 15 min | 低 |
| 8 | pwa.js | 25 min | 中 |
| 9 | artifacts.js | 25 min | 低 |
| 10 | app-core.js 扩展 + init 迁移 | 45 min | **高** |
| 11 | 内存文件 IO 包装器清理 | 15 min | 低 |
| 12 | onclick → data-action 收尾 | 30 min | 中 |
| 13 | 轻型包装器消除 | 45 min | 中 |
| 14 | SW 版本号自动化 | 10 min | 低 |
| 15 | 最终清理 + 回归 | 30 min | **高** |
| **合计** | | **~8 小时** | |

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 新建 | `public/js/litterbox.js` |
| 新建 | `public/js/diary.js` |
| 新建 | `public/js/bookshelf.js` |
| 新建 | `public/js/backup.js` |
| 新建 | `public/js/email.js` |
| 新建 | `public/js/weather.js` |
| 新建 | `public/js/pwa.js` |
| 新建 | `public/js/artifacts.js` |
| 修改 | `public/js/memory.js`（+~1200 行） |
| 修改 | `public/js/app-core.js`（+~250 行） |
| 修改 | `public/js/chat.js`（改调用 + 删 maybeAddMemory/maybeAICommentOnDiary） |
| 修改 | `public/js/ui.js`（新增 data-action case） |
| 修改 | `public/index.html`（-~3400 行，仅保留 HTML + CSS + script 标签） |
| 修改 | `public/service-worker.js`（版本号自动化） |
