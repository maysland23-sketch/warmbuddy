/**
 * WarmBuddy CustomPromptModule
 *
 * Prompt definitions are global, while enablement and injection schedules are
 * stored on each chat window. Injection is request-only and never enters the
 * chat message history.
 */
var CustomPromptModule = (function() {
  'use strict';

  var DEFAULT_INTERVAL = 5;
  var MIN_INTERVAL = 1;
  var MAX_BODY_LENGTH = 3000;
  var MAX_ENABLED_BODY_LENGTH = 6000;

  function now() { return Date.now(); }

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function codePointLength(value) {
    return Array.from(String(value || '')).length;
  }

  function notify(message) {
    try {
      if (typeof UIModule !== 'undefined' && UIModule && typeof UIModule.toast === 'function') {
        UIModule.toast(message);
      }
    } catch (e) {
      // Toasts are best-effort; validation must still remain safe in startup/tests.
    }
  }

  function persist() {
    try {
      if (AppCore && typeof AppCore.saveStore === 'function') AppCore.saveStore();
      return true;
    } catch (e) {
      try { console.warn('[CustomPromptModule] local persistence failed:', e.message); } catch (ignored) {}
      notify('自定义提示词保存失败，请检查本地存储空间。');
      return false;
    }
  }

  function getStore() {
    var store = AppCore.getStore();
    if (!store || typeof store !== 'object') throw new Error('store unavailable');
    return store;
  }

  function makeId() {
    var id = '';
    try { id = AppCore.gid('cp_'); } catch (e) {}
    return id || ('cp_' + now().toString(36) + Math.random().toString(36).slice(2, 8));
  }

  function normalizeInterval(value) {
    var interval = Number(value);
    if (!isFinite(interval) || interval < MIN_INTERVAL) return DEFAULT_INTERVAL;
    return Math.max(MIN_INTERVAL, Math.floor(interval));
  }

  function uniqueId(candidate, seen) {
    var base = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : makeId();
    var id = base;
    var suffix = 1;
    while (seen[id]) id = base + '_' + suffix++;
    seen[id] = true;
    return id;
  }

  function normalizePersistedDefinition(raw, seen) {
    if (!isObject(raw)) return null;
    var content = typeof raw.content === 'string' ? raw.content : '';
    if (!content.trim()) return null;
    if (codePointLength(content) > MAX_BODY_LENGTH) {
      content = Array.from(content).slice(0, MAX_BODY_LENGTH).join('');
    }
    var timestamp = Number(raw.createdAt) || now();
    return {
      id: uniqueId(raw.id, seen),
      title: typeof raw.title === 'string' ? raw.title : '',
      content: content,
      interval: normalizeInterval(raw.interval),
      createdAt: timestamp,
      updatedAt: Number(raw.updatedAt) || timestamp
    };
  }

  function normalizeStore() {
    var store = getStore();
    var source = Array.isArray(store.customPrompts) ? store.customPrompts : [];
    var seen = {};
    var normalized = [];
    source.forEach(function(raw) {
      var definition = normalizePersistedDefinition(raw, seen);
      if (definition) normalized.push(definition);
    });
    store.customPrompts = normalized;
    return normalized;
  }

  function cloneDefinition(definition) {
    return {
      id: definition.id,
      title: definition.title,
      content: definition.content,
      interval: definition.interval,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt
    };
  }

  function getDefinitions() {
    var store = getStore();
    if (!Array.isArray(store.customPrompts)) normalizeStore();
    return store.customPrompts.map(cloneDefinition);
  }

  function findDefinition(promptId) {
    var store = getStore();
    if (!Array.isArray(store.customPrompts)) normalizeStore();
    return store.customPrompts.find(function(definition) { return definition.id === promptId; }) || null;
  }

  function ensureChatState(chat) {
    if (!chat || typeof chat !== 'object') return null;
    var round = Number(chat.customPromptRound);
    chat.customPromptRound = isFinite(round) && round >= 0 ? Math.floor(round) : 0;
    if (!isObject(chat.customPromptStates)) chat.customPromptStates = {};
    return chat;
  }

  function forEachChat(callback) {
    var store = getStore();
    var seen = {};
    var projects = Array.isArray(store.projects) ? store.projects : [];
    projects.forEach(function(project) {
      (Array.isArray(project && project.chats) ? project.chats : []).forEach(function(chat) {
        if (!chat || !chat.id || seen[chat.id]) return;
        seen[chat.id] = true;
        callback(chat);
      });
    });
    try {
      var active = AppCore.getActiveChatObj && AppCore.getActiveChatObj();
      if (active && active.id && !seen[active.id]) callback(active);
    } catch (e) {}
  }

  function enabledBodyLength(chat, exceptId) {
    ensureChatState(chat);
    var total = 0;
    getDefinitions().forEach(function(definition) {
      if (definition.id === exceptId) return;
      var state = chat.customPromptStates[definition.id];
      if (state && state.enabled) total += codePointLength(definition.content);
    });
    return total;
  }

  function toggleForChat(chat, promptId, enabled) {
    var definition = findDefinition(promptId);
    if (!definition || !ensureChatState(chat)) return false;
    var state = chat.customPromptStates[promptId];
    var shouldEnable = enabled === true;

    if (shouldEnable) {
      if (state && state.enabled) return true;
      if (enabledBodyLength(chat, promptId) + codePointLength(definition.content) > MAX_ENABLED_BODY_LENGTH) {
        notify('当前窗口已启用的自定义提示词总长度不能超过 6000 字。');
        return false;
      }
      chat.customPromptStates[promptId] = { enabled: true, nextRound: chat.customPromptRound + 1 };
    } else {
      chat.customPromptStates[promptId] = { enabled: false, nextRound: null };
    }
    persist();
    return true;
  }

  function toggleForActiveChat(promptId, enabled) {
    var chat = AppCore.getActiveChatObj && AppCore.getActiveChatObj();
    if (!chat) {
      notify('请先打开一个对话窗口。');
      return false;
    }
    return toggleForChat(chat, promptId, enabled);
  }

  function validUserBody(content) {
    return typeof content === 'string' && content.trim() && codePointLength(content) <= MAX_BODY_LENGTH;
  }

  function validUserInterval(value) {
    var interval = Number(value);
    return value !== '' && isFinite(interval) && interval >= MIN_INTERVAL && Math.floor(interval) === interval;
  }

  function createDefinition(input) {
    input = isObject(input) ? input : {};
    if (!validUserBody(input.content)) {
      notify(input.content && codePointLength(input.content) > MAX_BODY_LENGTH
        ? '自定义提示词内容最多 3000 字。'
        : '自定义提示词内容不能为空。');
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'interval') && !validUserInterval(input.interval)) {
      notify('注入频率至少为 1 轮。');
      return null;
    }
    var timestamp = now();
    var definition = {
      id: uniqueId(input.id, (function() {
        var used = {};
        getDefinitions().forEach(function(item) { used[item.id] = true; });
        return used;
      })()),
      title: typeof input.title === 'string' ? input.title : '',
      content: input.content,
      interval: normalizeInterval(input.interval),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    var store = getStore();
    if (!Array.isArray(store.customPrompts)) store.customPrompts = [];
    store.customPrompts.push(definition);
    persist();
    return cloneDefinition(definition);
  }

  function updateDefinition(promptId, patch) {
    var definition = findDefinition(promptId);
    if (!definition || !isObject(patch)) return false;
    var nextContent = Object.prototype.hasOwnProperty.call(patch, 'content') ? patch.content : definition.content;
    if (!validUserBody(nextContent)) {
      notify(nextContent && codePointLength(nextContent) > MAX_BODY_LENGTH
        ? '自定义提示词内容最多 3000 字。'
        : '自定义提示词内容不能为空。');
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'interval') && !validUserInterval(patch.interval)) {
      notify('注入频率至少为 1 轮。');
      return false;
    }
    var contentChanged = nextContent !== definition.content;
    if (contentChanged) {
      var exceeds = false;
      forEachChat(function(chat) {
        if (enabledBodyLength(chat, promptId) + codePointLength(nextContent) > MAX_ENABLED_BODY_LENGTH) exceeds = true;
      });
      if (exceeds) {
        notify('修改后当前窗口的自定义提示词总长度会超过 6000 字。');
        return false;
      }
    }
    var previousInterval = definition.interval;
    definition.title = Object.prototype.hasOwnProperty.call(patch, 'title') && typeof patch.title === 'string'
      ? patch.title : definition.title;
    definition.content = nextContent;
    definition.interval = Object.prototype.hasOwnProperty.call(patch, 'interval')
      ? normalizeInterval(patch.interval) : definition.interval;
    definition.updatedAt = now();

    if (definition.interval !== previousInterval) {
      forEachChat(function(chat) {
        ensureChatState(chat);
        var state = chat.customPromptStates[promptId];
        if (state && state.enabled) state.nextRound = chat.customPromptRound + 1;
      });
    }
    persist();
    return true;
  }

  function deleteDefinition(promptId) {
    var store = getStore();
    if (!Array.isArray(store.customPrompts)) return false;
    var before = store.customPrompts.length;
    store.customPrompts = store.customPrompts.filter(function(definition) { return definition.id !== promptId; });
    if (store.customPrompts.length === before) return false;
    forEachChat(function(chat) {
      if (chat.customPromptStates) delete chat.customPromptStates[promptId];
    });
    persist();
    return true;
  }

  function formatDefinition(definition) {
    var title = definition.title ? '标题：' + definition.title + '\n' : '';
    return '【自定义提示词开始】\n' + title + definition.content + '\n【自定义提示词结束】';
  }

  function beginAiRound(chat) {
    if (!ensureChatState(chat)) return { roundNumber: 0, content: '', injectedIds: [] };
    var roundNumber = ++chat.customPromptRound;
    var injected = [];
    getDefinitions().forEach(function(definition) {
      var state = chat.customPromptStates[definition.id];
      if (!state || !state.enabled) return;
      var nextRound = Number(state.nextRound);
      if (!isFinite(nextRound)) nextRound = roundNumber;
      if (nextRound <= roundNumber) {
        injected.push(definition);
        state.nextRound = roundNumber + definition.interval;
      }
    });
    persist();
    return {
      roundNumber: roundNumber,
      content: injected.map(formatDefinition).join('\n\n'),
      injectedIds: injected.map(function(definition) { return definition.id; })
    };
  }

  function escapeHtml(value) {
    try {
      return AppCore.escapeHtml(String(value || ''));
    } catch (e) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  }

  function encodeId(promptId) {
    return encodeURIComponent(promptId || '');
  }

  function getActiveChatForSettings() {
    try { return AppCore.getActiveChatObj && AppCore.getActiveChatObj(); } catch (e) { return null; }
  }

  function renderSettings() {
    var container = AppCore.$ && AppCore.$('customPromptList');
    if (!container) return '';
    var chat = getActiveChatForSettings();
    var definitions = getDefinitions();
    if (!chat || definitions.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-lighter);padding:4px 0;">暂无自定义提示词</div>';
      return container.innerHTML;
    }
    ensureChatState(chat);
    container.innerHTML = definitions.map(function(definition) {
      var state = chat.customPromptStates[definition.id];
      var enabled = !!(state && state.enabled);
      var preview = definition.content.replace(/\s+/g, ' ').slice(0, 72);
      if (definition.content.length > 72) preview += '…';
      var safeId = encodeId(definition.id);
      var label = definition.title || '未命名提示词';
      return '<div class="settings-item" style="cursor:default;align-items:flex-start;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(label) + '</div>' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-top:2px;line-height:1.4;white-space:normal;word-break:break-word;">' + escapeHtml(preview) + '</div>' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-top:3px;">每 ' + definition.interval + ' 轮注入</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:4px;margin-left:8px;flex-shrink:0;">' +
          '<button type="button" data-action="editCustomPrompt" data-args="' + safeId + '" style="border:0;background:transparent;color:var(--text-lighter);font-size:11px;cursor:pointer;padding:3px;">编辑</button>' +
          '<button type="button" data-action="deleteCustomPrompt" data-args="' + safeId + '" style="border:0;background:transparent;color:var(--danger);font-size:11px;cursor:pointer;padding:3px;">删除</button>' +
          '<div class="toggle-switch' + (enabled ? ' on' : '') + '" data-action="toggleCustomPrompt" data-args="' + safeId + '|' + (!enabled) + '" title="' + (enabled ? '当前窗口已开启' : '当前窗口未开启') + '"></div>' +
        '</div>' +
      '</div>';
    }).join('');
    return container.innerHTML;
  }

  function showEditor(promptId) {
    var definition = promptId ? findDefinition(promptId) : null;
    var title = definition ? definition.title : '';
    var content = definition ? definition.content : '';
    var interval = definition ? definition.interval : DEFAULT_INTERVAL;
    var idValue = definition ? encodeId(definition.id) : '';
    var body = '<input type="hidden" id="customPromptIdInput" value="' + idValue + '">' +
      '<label style="display:block;font-size:11px;color:var(--text-light);margin-bottom:4px;">标题（可选）</label>' +
      '<input class="modal-input" id="customPromptTitleInput" maxlength="100" placeholder="例如：写作风格" value="' + escapeHtml(title) + '">' +
      '<label style="display:block;font-size:11px;color:var(--text-light);margin:10px 0 4px;">内容（必填）</label>' +
      '<textarea class="modal-input modal-textarea" id="customPromptContentInput" maxlength="3000" rows="8" placeholder="输入要注入对话的提示词内容">' + escapeHtml(content) + '</textarea>' +
      '<label style="display:block;font-size:11px;color:var(--text-light);margin:10px 0 4px;">注入频率</label>' +
      '<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-light);"><span>每</span><input class="modal-input" id="customPromptIntervalInput" type="number" min="1" step="1" value="' + interval + '" style="width:90px;margin:0;"><span>轮对话注入一次</span></div>' +
      '<div style="font-size:10px;color:var(--text-lighter);line-height:1.5;margin-top:8px;">下一次实际 AI 请求会立即注入。开启内容会发送给当前配置的模型服务。</div>';
    UIModule.showModal(definition ? '编辑自定义提示词' : '新建自定义提示词', body, [
      { label: '取消', cls: 'cancel', onclick: UIModule.closeModal },
      { label: '保存', cls: 'confirm', onclick: saveEditor }
    ]);
  }

  function saveEditor() {
    var titleEl = AppCore.$('customPromptTitleInput');
    var contentEl = AppCore.$('customPromptContentInput');
    var intervalEl = AppCore.$('customPromptIntervalInput');
    var idEl = AppCore.$('customPromptIdInput');
    if (!contentEl || !intervalEl) return false;
    var rawId = idEl && idEl.value ? decodeURIComponent(idEl.value) : '';
    var content = contentEl.value;
    var interval = Number(intervalEl.value);
    if (!validUserInterval(intervalEl.value)) {
      notify('注入频率至少为 1 轮。');
      return false;
    }
    var saved = rawId
      ? updateDefinition(rawId, { title: titleEl ? titleEl.value : '', content: content, interval: interval })
      : !!createDefinition({ title: titleEl ? titleEl.value : '', content: content, interval: interval });
    if (!saved) return false;
    UIModule.closeModal();
    renderSettings();
    return true;
  }

  function init() {
    try { normalizeStore(); } catch (e) {
      try { console.warn('[CustomPromptModule] initialization failed:', e.message); } catch (ignored) {}
    }
  }

  return {
    init: init,
    getDefinitions: getDefinitions,
    renderSettings: renderSettings,
    showEditor: showEditor,
    saveEditor: saveEditor,
    toggleForActiveChat: toggleForActiveChat,
    toggleForChat: toggleForChat,
    deleteDefinition: deleteDefinition,
    beginAiRound: beginAiRound,
    normalizeStore: normalizeStore,
    createDefinition: createDefinition,
    updateDefinition: updateDefinition,
    formatDefinition: formatDefinition,
    constants: {
      DEFAULT_INTERVAL: DEFAULT_INTERVAL,
      MAX_BODY_LENGTH: MAX_BODY_LENGTH,
      MAX_ENABLED_BODY_LENGTH: MAX_ENABLED_BODY_LENGTH
    }
  };
})();

AppCore.register('customPrompts', CustomPromptModule);
