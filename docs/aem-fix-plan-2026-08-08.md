# AEM 修复与加固方案

> **日期**：2026-08-08
> **目标**：修复 AEM 过滤 Bug、添加 syncNow、超量清理、Supabase 同步、AEM 展开详情

---

## 决策

| 问题 | 决策 |
|------|------|
| Supabase 同步 | 全量覆盖（本地 filter 删除 → scheduleSync → Supabase 清理） |
| syncNow | 仅新增/更新时调用，不用于删除 |
| AEM 超量 | load 时一次性 cleanup + 每次 addAEM 时 filter |
| decay 归零 | scheduleSync 全量推送时自然清理 |

---

## 实施步骤

### Step 1：修复 AEM 过滤 Bug + load 时一次性清理

**文件**：`public/js/memory.js`

**1a. 修复 addAEM filter（第 138-139 行）**

```diff
- c.aems = c.aems.filter(function(m) {
-   return m.starred || (m.decayFactor || 0) > 0;
- });
+ c.aems = c.aems.filter(function(m) {
+   return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0;
+ });
```

**1b. 同步修复 addUSM 中同样的 filter**（如果存在）

**1c. load 后添加一次性清理**

```javascript
// After mergeFromSupabase + persistCache, add:
// Cleanup: remove fully-decayed non-starred items and enforce cap
c.aems = c.aems.filter(function(m) {
  return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0;
});
if (c.aems.length > 200) c.aems.length = 200;
// Same for usms
c.usms = c.usms.filter(function(m) {
  return m.starred || (m.decayFactor === undefined) || (m.decayFactor || 0) > 0;
});
if (c.usms.length > 200) c.usms.length = 200;
```

### Step 2：新增 syncNow 方法

**文件**：`public/js/memory.js` — MemoryModule 公开 API

```javascript
syncNow: function(projectId) {
  if (!projectId) return;
  clearSyncTimer(projectId);
  pushToSupabase(projectId);
},
```

### Step 3：关键写入点调用 syncNow

**文件**：`public/js/memory.js`

在 `addAEM`、`addUSM`、`update` 方法末尾的 `MemoryModule.save(projectId)` 之后或替换为：

```javascript
// addAEM: 在 rebuildBM25Sync + save 之后
MemoryModule.save(projectId);
MemoryModule.syncNow(projectId);

// addUSM: 同样
// update: 同样
```

### Step 4：AEM 排序修复 + 展开显示 sync/decay 信息

**文件**：`public/index.html` — core tab 渲染部分

**4a. 添加时间排序**

在 AEM 渲染前显式按 timestamp 降序排列：

```javascript
aems.sort(function(a, b) {
  return (b.timestamp || '').localeCompare(a.timestamp || '');
});
```

**4b. 展开时显示 Supabase 同步时间 + decay 程度**

在 AEM 卡片下方添加 expandable 区：

```javascript
var decayLabel = '';
if (aem.decayFactor !== undefined) {
  var pct = Math.round((aem.decayFactor || 0) * 100);
  decayLabel = '<span style="font-size:10px;color:var(--text-lighter);">decay: ' + pct + '%</span>';
}
var supabaseNote = aem._syncedAt
  ? '<span style="font-size:10px;color:var(--text-lighter);">sync: ' + toLocalDisplayTime(aem._syncedAt) + '</span>'
  : '<span style="font-size:10px;color:var(--text-lighter);">sync: pending</span>';
```

### Step 5：pushToSupabase 增加时间戳

**文件**：`public/js/memory.js`

在 `pushToSupabase` 推送成功后，给每个推送的 AEM 标记 `_syncedAt`：

```javascript
if (resp.ok) {
  _dirty[projectId] = false;
  var syncedAt = new Date().toISOString();
  allMems.forEach(function(m) {
    var idx = findIndexById(c.aems, m.id);
    if (idx >= 0) c.aems[idx]._syncedAt = syncedAt;
  });
}
```

### Step 6：验证

- [ ] `addAEM` filter 不再误删新 AEM
- [ ] load 后一次性清理超量数据
- [ ] syncNow 立即推送新增 AEM 到 Supabase
- [ ] AEM 按时间倒序排列
- [ ] 展开显示 decay 百分比 + Supabase 同步时间
- [ ] 数量不超过 200
