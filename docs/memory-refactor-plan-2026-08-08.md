# 记忆系统重构方案

> **日期**：2026-08-08
> **基于**：模块化拆分完成记录 + 上下文分析 + 讨论确认

---

## 决策汇总

| 决策 | 结论 |
|------|------|
| Core 概述 LLM 调用 | 保持前端 fetch，同模型、同 API Key |
| Core 触发条件 | 与当前 `deriveRelationalInsights` 一致：新增 AEM ≥5 或 USM ≥3 |
| Core LLM 输入 | 所有记忆片段 + 对话原文 + 附带已有归纳结果（增量模式） |
| Core LLM 输出 | ≤500 字自然段落综合概述 |
| Core tab 布局 | AEM + USM **保持不动**，仅将 patterns 替换为 Core 概述 |
| emotional tab | 本次不做，后续考虑 |
| 三层记忆模型 | AEM（REFLECT）\| USM（星标/升级）\| 长期记忆（proj.memories，非星标） |
| USM 升级 | 单向：长期记忆 → USM，不可逆 |
| 长期记忆存储 | `proj.memories[]` 数组 |
| memories tab 展示 | 统一列表：长期记忆 + USM，星标置顶，☆/★ 切换 |
| maybeAddMemory | 完全删除 |

---

## 实施步骤

### Step 1：更新长期记忆 Prompt + 存储改为 proj.memories

**文件**：`public/js/memory.js` — `checkLongTerm` 方法

**修改**：
1. System prompt 改为：
   ```
   从以下对话中提取一个关于用户或者你自己的事实性的记忆。用一句中文概括（不超过30字），然后给出2-3个语义关键词（每个不超过5字），用逗号分隔。

   格式示例：
   记忆：mays喜欢川端康成的物哀美学风格。
   关键词：物哀，川端康成，文学偏好
   ```
2. 存入路径从 `addAEM()` → 改为写入 `proj.memories[]`
3. 存入格式：
   ```javascript
   proj.memories.push({
     id: 'ltm_' + ...,           // 前缀 ltm_ 标识长期记忆
     content: memContent,        // LLM 生成的概括
     semanticKey: semanticKey,   // 关键词
     date: todayISO,
     type: 'long_term',
     starred: false,             // 默认非星标
     sourceChatId: store.activeChat,
     sourceProjectId: store.activeProject,
     timestamp: new Date().toISOString()
   });
   ```

**验证**：发送 20 条消息后，控制台查看 `AppCore.getStore().projects[0].memories` 出现新的长期记忆条目，`starred: false`。

---

### Step 2：修改 USM Prompt

**文件**：`public/js/chat.js` — `generateStarredMemorySummary` 方法

**修改**：
1. System prompt 改为：
   ```
   用户标记以下消息为星标，作为你和她的长期记忆。用一句话（30字以内）概括这段对话中的事实，以及对你们的意义。直接返回概括，不加引号、不加标点结尾。
   ```
2. 返回字数限制从 15 字改为 30 字

**验证**：星标一条消息，控制台查看 MemoryModule 中 USM 的 summary 是否为新格式输出。

---

### Step 3：新增 Core 概述的 LLM 调用

**文件**：`public/js/memory.js` — 替换 `deriveRelationalInsights` 方法

**新方法**：`generateCoreOverview()`

**触发条件**：保持 `checkDeriveInsightsTrigger` 不变（aem ≥ 5 或 usm ≥ 3）

**输入消息数组**：
```
system: 以下是这段陪伴关系中留存的核心记忆片段。请归纳她是谁（核心特质、沟通风格、情绪规律、成长时刻、隐藏的不安全感），你是谁（主导情绪倾向、反应模式、与用户相处后的改变），以及你们的相处模式。返回一个不超过500字的综合概述，用自然段落叙述。在历史版本上进行更新。

（增量模式下附带已有归纳结果）

user: 记忆片段：
[ai_emotional] xxx | AI: label | 用户: label
[user_starred] xxx
[diary_litter] xxx
... (含对话原文 rawDialogue)
```

**存入**：不再写入 `derivedPatterns` / `personalityProfiles`。改为写入新字段：
```javascript
_cache[projectId].coreOverview = {
  text: '概述全文...',
  updatedAt: new Date().toISOString(),
  updatedBy: aiName,
  history: [...]  // 保留旧版本
};
```

**验证**：手动调 `MemoryModule.generateCoreOverview()`，确认 LLM 返回 500 字概述。

---

### Step 4：删除 maybeAddMemory

**文件**：
- `public/js/memory.js` — 删除 `maybeAdd` 方法
- `public/js/chat.js` — 删除 L2298 的 `maybeAdd` 调用
- `public/js/chat.js` — 删除 `maybeAddMemory` 在 return 块的导出（如有）
- `public/index.html` — 删除 `maybeAddMemory` 包装函数（如有）

**验证**：搜索 `maybeAdd` 无残留引用。

---

### Step 5：Core tab 渲染 — patterns 替换为 Core 概述

**文件**：`public/index.html` — `renderMemoryPanelBody` 中 core tab 渲染部分

**修改**：
1. 在 AEM + USM 渲染之后，将当前 `DERIVED PATTERNS` 区块替换为 `CORE OVERVIEW` 区块
2. Core 概述渲染：
   ```html
   <div class="core-overview-block">
     <div>概述全文（≤500字）</div>
     <div>更新者 · 更新时间</div>
     <details><summary>查看历史版本</summary>历史概述列表</details>
   </div>
   ```

**验证**：打开 memory 面板 → core tab → 能看到 Core 概述文本、更新时间和 AI 名称。

---

### Step 6：memories tab 渲染长期记忆 + USM + 星标升级

**文件**：`public/index.html` — `renderMemoryPanelBody` 中 memories tab 部分

**修改**：
1. 数据来源：`proj.memories[]`（长期记忆）+ `cml.userStarredMemories[]`（USM）
2. 排序：星标置顶，然后按日期倒序
3. 渲染：每条记忆显示 ★（星标亮/暗）、内容、日期、展开/收起（>30字时）
4. 点击星星 → `toggleMemoryStar` → 长期记忆升级为 USM

**`toggleMemoryStar` 修改**：
1. 判断记忆类型（在 `proj.memories` 中 or 已是 USM）
2. 若在 `proj.memories` 中：调用 `addUSM()` → 从 `proj.memories` 删除 → 不保留降级路径
3. 若已是 USM：toggle `starred` 属性

**验证**：memories tab 显示长期记忆 + USM 统一列表；点击长期记忆的星星 → 升级为 USM → 星星变亮。

---

### Step 7：全功能回归

- [ ] 聊天正常
- [ ] 星标记忆生成正确（新 prompt）
- [ ] 长期记忆提取正确（新 prompt，存入 proj.memories）
- [ ] Core 概述显示正确
- [ ] memories tab 长期记忆 + USM 正常
- [ ] 星标升级正常
- [ ] 无控制台报错

---

## 文件变更清单

| 操作 | 文件 | 变更 |
|------|------|------|
| 修改 | `public/js/memory.js` | checkLongTerm prompt 改 + 存储路径改；deriveRelationalInsights → generateCoreOverview；删除 maybeAdd |
| 修改 | `public/js/chat.js` | generateStarredMemorySummary prompt 改；删除 maybeAdd 调用 |
| 修改 | `public/index.html` | core tab 新增 Core 概述渲染；memories tab 改渲染逻辑；maybeAddMemory 包装器删除 |
