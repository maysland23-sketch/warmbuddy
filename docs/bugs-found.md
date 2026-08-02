# Bug 审计记录

> 拆分前审查发现的问题。拆分过程中**不修复**，仅记录。全部拆分完成后另行安排。

---

## 1. `migrateStoreAsync` 中的 `cml` 作用域 Bug

- **位置**：`index.html` L1533
- **代码**：`if (cml.aiEmotionalMemories.some(...))`
- **现象**：`cml` 变量在 L1371 的 `for...of` 循环中以 `const` 声明，循环结束后不在作用域内。如果 L1529-1556 的 v2.0 迁移代码被执行，会抛出 `ReferenceError: cml is not defined`。
- **实际影响**：**低** — L1404 在大多数情况下已将 `_coreMemories_migrated` 设为 `true`，使此代码路径被跳过。仅在极古老的 v1 数据且未经过 v2.1 迁移循环时可能触发。
- **建议修复**：将 `cml` 替换为从 `store.projects[0].coreMemoryLayers` 获取，或删除此死代码块。

---

## 2. `delete getCoreMemoryLayers` 无效

- **位置**：`index.html` L1403
- **代码**：`if (getCoreMemoryLayers()) delete getCoreMemoryLayers();`
- **现象**：在非严格模式下，`delete` 对函数声明无效（静默失败）。该函数仍然存在且可调用。
- **实际影响**：**极低** — 该函数只是一个包装器，保留不会导致错误。意图应该是清理全局命名空间，但未实际生效。
- **建议修复**：改为 `window.getCoreMemoryLayers = undefined;` 或直接删除此行（因为该辅助函数在其他地方被使用）。

---

## 3. `saveStore` 在 UI 未初始化时调用 `toast()`

- **位置**：`index.html` L1250
- **代码**：`toast('⚠️ 存储空间不足，请导出数据后清理旧对话');`
- **现象**：`saveStore()` 可能在 UI 模块初始化之前被调用（如 migrate 期间），此时 `toast` 函数尚未定义，导致静默失败或 `ReferenceError`。
- **实际影响**：**低** — 仅在 QuotaExceededError 时触发，且 `toast` 未定义时调用只会静默抛错，不影响数据保存。
- **建议修复**：加 `typeof toast === 'function'` 守卫。

---

## 4. `Object.assign` 无白名单，可能残留废弃属性

- **位置**：`index.html` L1282
- **代码**：`Object.assign(store, saved);`
- **现象**：如果旧版本 store 中存在某属性，新版本默认 store 中已删除，加载后该属性会残留。没有白名单机制清理过时字段。
- **实际影响**：**低** — migrateStoreAsync 中有大量的字段修补逻辑，大部分情况下数据兼容性良好。但极端情况下（如大版本跳过），可能残留废数据占用存储。
- **建议修复**：维护一个有效 store key 白名单，加载时过滤未知属性。

---

## 5. `loadStore` 调用 `migrateStoreAsync` 后没有处理迁移失败

- **位置**：`index.html` L1295
- **代码**：`await migrateStoreAsync();`
- **现象**：`migrateStoreAsync` 中如果某步抛出异常（如 Supabase 不可用 + 数据格式异常），整个 `loadStore` 会 reject，导致 `init()` 中断，页面可能白屏。
- **实际影响**：**中** — `migrateStoreAsync` 内部有大量嵌套逻辑，任何未捕获的异常都会阻止 init 完成。
- **建议修复**：用 `try/catch` 包裹 `await migrateStoreAsync()`，迁移失败时降级到使用未迁移数据，并记录错误日志。

---

## 6. `diarySelectedDate` 默认值使用 IIFE 在模块顶层立即执行

- **位置**：`index.html` L1198
- **代码**：`diarySelectedDate: (()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})()`
- **现象**：在 `const store = {...}` 声明时立即计算，如果页面在不同日期被多次加载（不刷新），该值不会自动更新为当天。
- **实际影响**：**极低** — 页面加载即初始化，该值在后续运行中会被 `loadStore` 覆盖。
- **建议修复**：无迫切需求，后续可改为惰性求值。

---

## 7. 全局 `store` 为 `const` 但通过 `Object.assign` 修改其属性

- **位置**：`index.html` L1108, L1282
- **代码**：`const store = {...}` + `Object.assign(store, saved)`
- **现象**：`const` 只保护引用不被重新赋值，但不保护属性被修改。这不是 bug，但容易被误解。将 store 传给 AppCore 后，如果其他模块意外执行 `store = something`，会得到不同的错误（`TypeError: Assignment to constant variable`），而不是静默创建新对象。
- **实际影响**：**无** — 这是正确的使用方式。
- **建议**：继续使用 `const`。

---

## 总结

| # | 严重程度 | 说明 |
|---|---------|------|
| 1 | 低 | `cml` 作用域 — 死代码路径 |
| 2 | 极低 | `delete` 函数声明无效 |
| 3 | 低 | toast 未初始化时调用 |
| 4 | 低 | 无白名单可能残留废弃属性 |
| 5 | **中** | migrateStoreAsync 异常未捕获可能导致 init 中断 |
| 6 | 极低 | 日期 IIFE 仅计算一次 |
| 7 | 无 | const 语义正确 |
| 8 | 中 | `deriveRelationalInsights` 中 AEM `aiSelfEval`/`userStateAtTime` 可能为 undefined → 已修复（空值守卫） |
| 9 | 低 | `deriveRelationalInsights` 中 `dlb.summary`/`dlb.type` 可能为 undefined → 已修复（空值守卫） |
| 10 | 低 | `checkWeeklyAutoExport` 30s 延迟后未执行（非周一且已有导出记录时 skip），但无报错。非阻塞性问题，不影响功能。 |
