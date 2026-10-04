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

  function createDefinition(input) {
    input = isObject(input) ? input : {};
    if (!validUserBody(input.content)) {
      notify(input.content && codePointLength(input.content) > MAX_BODY_LENGTH
        ? '自定义提示词内容最多 3000 字。'
        : '自定义提示词内容不能为空。');
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

  function renderSettings() { return ''; }
  function showEditor() {}
  function saveEditor() { return false; }

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
