/**
 * WarmBuddy SyncModule v1.0
 * ── Backend synchronization, system events polling, config sync ──
 */

var SyncModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Internal state
  // ═══════════════════════════════════════════
  var _syncMessagesTimer = null;
  var SYNC_BATCH_SIZE = 20;

  // ═══════════════════════════════════════════
  //  Todo sync
  // ═══════════════════════════════════════════
  function syncTodosToBackend() {
    var store = AppCore.getStore();
    var proj = getActiveProject(); if (!proj) return;
    fetch(AppCore.BACKEND_URL + '/api/todos/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: proj.id,
        todos: store.todos.map(function(t) {
          var isoTime = null;
          var raw = t.time || '';
          if (raw && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) {
            var cleaned = raw.replace(' ', 'T').replace(/[Zz]$/, '').replace(/[+-]\d{2}:\d{2}$/, '').replace(/[+-]\d{4}$/, '');
            isoTime = new Date(cleaned).toISOString();
          } else if (raw && /^\d{1,2}:\d{2}$/.test(raw)) {
            var today = new Date();
            var parts = raw.split(':'); var h = parseInt(parts[0]), m = parseInt(parts[1]);
            today.setHours(h, m, 0, 0);
            isoTime = today.toISOString();
          } else if (t.deadline && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline)) {
            isoTime = new Date(t.deadline + 'T23:59:00Z').toISOString();
          }
          return {
            id: t.id, title: t.text || t.title,
            time: isoTime, creator: t.creator || 'user',
            chat_id: t.chatId || '',
            triggered: t.triggered || false, done: t.done || false
          };
        })
      })
    }).catch(function(e) { console.warn('[sync-todos] Failed:', e.message); });
  }

  function fetchTodosFromBackend(projectId) {
    if (!projectId) return;
    var store = AppCore.getStore();
    fetch(AppCore.BACKEND_URL + '/api/todos/' + encodeURIComponent(projectId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.todos || !data.todos.length) return;
        var backendTodos = data.todos;
        var merged = false;
        for (var i = 0; i < backendTodos.length; i++) {
          var bt = backendTodos[i];
          var existing = store.todos.find(function(t) { return t.id === bt.id; });
          if (existing) {
            if (bt.done !== undefined) existing.done = bt.done;
            if (bt.triggered !== undefined) existing.triggered = bt.triggered;
          } else {
            store.todos.unshift({
              id: bt.id, text: bt.title, done: bt.done || false,
              time: bt.time || '', type: bt.time && /^\d{4}-\d{2}-\d{2}/.test(bt.time) ? 'long' : 'short',
              creator: bt.creator || 'user', chatId: bt.chat_id || '',
              createdAt: bt.created_at, triggered: bt.triggered || false,
              projectId: projectId
            });
            merged = true;
          }
        }
        if (merged) { AppCore.saveStore(); if (typeof renderTodos === 'function') renderTodos(); }
        console.log('[fetch-todos] Loaded ' + backendTodos.length + ' todos from backend');
      }).catch(function(e) { console.warn('[fetch-todos] Failed:', e.message); });
  }

  // ═══════════════════════════════════════════
  //  Config sync
  // ═══════════════════════════════════════════
  function buildChatContextSummary() {
    var store = AppCore.getStore();
    var proj = getActiveProject(); if (!proj) return '';
    var chat = getActiveChatObj();
    var parts = [];
    var cml = proj.id ? MemoryModule.getCML(proj.id) : null;
    if (cml && cml.aiEmotionalMemories && cml.aiEmotionalMemories.length > 0) {
      var recentAEM = cml.aiEmotionalMemories.slice(0, 3);
      var aemLines = [];
      for (var i = 0; i < recentAEM.length; i++) {
        var a = recentAEM[i];
        aemLines.push('- ' + (a.summary || a.content || '').slice(0, 60));
      }
      if (aemLines.length > 0) parts.push('最近情绪记忆：\n' + aemLines.join('\n'));
    }
    if (chat && chat.messages && chat.messages.length > 0) {
      var recent = chat.messages.filter(function(m) { return m.role === 'user' || m.role === 'ai'; }).slice(-16);
      if (recent.length > 0) {
        var lines = [];
        for (var i2 = 0; i2 < recent.length; i2++) {
          var m = recent[i2];
          var role = m.role === 'user' ? '用户' : '暖伴';
          var text = (m.text || '').slice(0, 80).replace(/\n/g, ' ');
          lines.push(role + ': ' + text);
        }
        parts.push('最近对话：\n' + lines.join('\n'));
      }
    }
    return parts.join('\n\n');
  }

  function syncProjectConfigToBackend(updateChatTime) {
    var store = AppCore.getStore();
    var proj = getActiveProject(); if (!proj) return;
    var chat = getActiveChatObj();
    var cfg = getActiveApiConfig();
    var apiKey = cfg.apiKey || store.apiKey || '';
    var endpoint = cfg.endpoint || store.apiEndpoint || 'https://api.deepseek.com/v1/chat/completions';
    var enabledVal = cfg.enabled !== false;
    var ais = getActiveChatAiSettings();
    var config = {
      apiKey: apiKey, endpoint: endpoint, model: cfg.model || 'deepseek-chat',
      enabled: enabledVal,
      aiName: getAIName(),
      _chatId: chat ? chat.id : '',
      systemPrompt: proj.preference || '',
      chatSummary: buildChatContextSummary(),
      coreOverview: (function() {
        if (typeof MemoryModule !== 'undefined' && MemoryModule.getCoreOverview) {
          var co = MemoryModule.getCoreOverview(proj.id);
          if (co && co.text) return co.text;
        }
        return (proj.coreOverview && proj.coreOverview.text) || '';
      })(),
      timezoneOffset: -(new Date().getTimezoneOffset()),
      _windowSettings: {
        autoWeather: ais.autoWeather || false,
        webSearch: ais.webSearch || false
      },
      weatherText: (store.weather && store.weather.text) ? store.weather.text : '',
      _userStatus: proj._userStatus || '',
      _aiStatus: proj._aiStatus || ''
    };
    if (updateChatTime) {
      config.lastUserMessageTime = new Date().toISOString();
      config.chatSummaryUpdatedAt = new Date().toISOString();
    }
    fetch(AppCore.BACKEND_URL + '/api/projects/sync-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: proj.id, config: config })
    }).catch(function(e) { console.warn('[sync-config] Failed:', e.message); });
  }

  // ═══════════════════════════════════════════
  //  Message sync
  // ═══════════════════════════════════════════
  function syncMessagesToBackend() {
    var store = AppCore.getStore();
    var proj = getActiveProject(); if (!proj) return;
    var chat = getActiveChatObj(); if (!chat || !chat.messages) return;
    var unsynced = [];
    for (var i = 0; i < chat.messages.length; i++) {
      var m = chat.messages[i];
      if (m._synced || !m.id) continue;
      if (m.role !== 'user' && m.role !== 'ai') continue;
      if (m._isHandoffNote) continue;
      unsynced.push({
        project_id: proj.id,
        window_id: chat.id,
        message_id: m.id,
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: m.text || '',
        token_usage: m._tokenUsage || 0,
        created_at: m.createdAt || new Date().toISOString(),
        metadata: { contentType: m.contentType || '' }
      });
    }
    if (unsynced.length === 0) return;
    var totalSynced = 0;
    function sendBatch(idx) {
      if (idx >= unsynced.length) {
        if (totalSynced > 0) {
          console.log('[sync-msgs] Synced ' + totalSynced + ' messages (batched)');
          AppCore.saveStore();
        }
        return;
      }
      var batch = unsynced.slice(idx, idx + SYNC_BATCH_SIZE);
      fetch(AppCore.BACKEND_URL + '/api/sync-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: batch })
      }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.synced > 0) {
            totalSynced += data.synced;
            for (var j = 0; j < batch.length; j++) {
              var msg = chat.messages.find(function(m2) { return m2.id === batch[j].message_id; });
              if (msg) msg._synced = true;
            }
          }
          sendBatch(idx + SYNC_BATCH_SIZE);
        })
        .catch(function(e) {
          console.warn('[sync-msgs] Batch failed (' + (idx / SYNC_BATCH_SIZE + 1) + '), retrying next round');
        });
    }
    sendBatch(0);
  }

  function scheduleMessageSync() {
    if (_syncMessagesTimer) clearTimeout(_syncMessagesTimer);
    _syncMessagesTimer = setTimeout(syncMessagesToBackend, 2000);
  }

  function getLocalTimestampParts(isoString) {
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return { date: '', time: '' };
    return {
      date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      time: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    };
  }

  function cloudMessageToLocal(row) {
    var metadata = row.metadata || {};
    var parts = getLocalTimestampParts(row.createdAt);
    var role = row.role === 'assistant' ? 'ai' : (row.role || 'system');
    return {
      id: row.messageId,
      role: role,
      text: row.content || '',
      date: parts.date,
      time: parts.time,
      createdAt: row.createdAt,
      _proactive: !!metadata.proactive,
      _todoWake: metadata.action_type === 'todo_wake',
      _desireType: metadata.drive_key || '',
      contentType: metadata.content_type || metadata.contentType || '',
      _synced: true,
      _proactiveMessageId: row.messageId
    };
  }

  function findExistingCloudMessage(chat, localMessage) {
    var exact = chat.messages.find(function(m) { return m.id === localMessage.id; });
    if (exact) return exact;
    // Reconcile bubbles created by older builds, whose IDs were generated during polling.
    return chat.messages.find(function(m) {
      var legacySystemNotice = m.role === 'system' && localMessage.role === 'system';
      return (m._proactive || legacySystemNotice) && m.role === localMessage.role &&
        (m.text || '') === localMessage.text &&
        (!localMessage.time || (m.time || '').indexOf(localMessage.time) >= 0);
    }) || null;
  }

  function mergeCloudMessages(proj, rows) {
    var store = AppCore.getStore();
    var changed = false;
    (rows || []).forEach(function(row) {
      var localMessage = cloudMessageToLocal(row);
      var chat = proj.chats.find(function(c) { return c.id === row.windowId; });
      if (!chat) chat = proj.chats[proj.chats.length - 1];
      if (!chat || !localMessage.id) return;
      var existing = findExistingCloudMessage(chat, localMessage);
      if (existing) {
        var needsUpdate = existing.id !== localMessage.id || existing.role !== localMessage.role ||
          existing.text !== localMessage.text || existing.createdAt !== localMessage.createdAt ||
          existing._synced !== true;
        if (needsUpdate) {
          Object.assign(existing, localMessage);
          changed = true;
        }
      } else {
        chat.messages.push(localMessage);
        changed = true;
      }
    });
    if (changed) {
      function sortTime(message) {
        if (message.createdAt) return message.createdAt;
        var date = message.date;
        var timeMatch = (message.time || '').match(/(\d{2}:\d{2})/);
        if (!date) {
          var dateMatch = (message.time || '').match(/(\d{4}-\d{2}-\d{2})/);
          date = dateMatch && dateMatch[1];
        }
        return date && timeMatch ? date + 'T' + timeMatch[1] : '';
      }
      proj.chats.forEach(function(chat) {
        chat.messages.sort(function(a, b) {
          var aTime = sortTime(a);
          var bTime = sortTime(b);
          if (!aTime || !bTime) return 0;
          return aTime.localeCompare(bTime);
        });
      });
      AppCore.saveStore();
      if (proj.id === store.activeProject && typeof renderChatMessages === 'function') renderChatMessages(true);
    }
    return changed;
  }

  function pullChatMessages(projectId) {
    if (!projectId) return Promise.resolve();
    var store = AppCore.getStore();
    var proj = store.projects.find(function(p) { return p.id === projectId; });
    if (!proj) return Promise.resolve();
    var targetChatId = projectId === store.activeProject
      ? store.activeChat
      : (proj._lastActiveChat || (proj.chats.length ? proj.chats[proj.chats.length - 1].id : ''));
    var since = proj._lastChatMessagePoll || '';
    var querySince = since;
    if (since) {
      var sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) querySince = new Date(sinceDate.getTime() - 1000).toISOString();
    }
    var url = AppCore.BACKEND_URL + '/api/chat-messages?projectId=' + encodeURIComponent(projectId);
    if (targetChatId) url += '&targetWindowId=' + encodeURIComponent(targetChatId);
    if (querySince) url += '&since=' + encodeURIComponent(querySince);
    return fetch(url).then(function(r) { return r.json(); }).then(function(data) {
      var rows = data.messages || [];
      mergeCloudMessages(proj, rows);
      var maxCreatedAt = rows.reduce(function(max, row) {
        return row.createdAt && row.createdAt > max ? row.createdAt : max;
      }, since || '');
      if (maxCreatedAt) proj._lastChatMessagePoll = maxCreatedAt;
      if (rows.length) AppCore.saveStore();
    }).catch(function(e) {
      console.warn('[pull-chat-messages] Failed:', e.message);
    });
  }

  // ═══════════════════════════════════════════
  //  Project state reconciliation
  // ═══════════════════════════════════════════
  async function pullAllProjectEnabledStates() {
    var store = AppCore.getStore();
    try {
      var resp = await fetch(AppCore.BACKEND_URL + '/api/projects/configs');
      var data = await resp.json();
      if (data.configs) {
        for (var i = 0; i < store.projects.length; i++) {
          var proj = store.projects[i];
          var backendCfg = data.configs[proj.id];
          if (backendCfg) {
            if (!proj.apiConfig) proj.apiConfig = {};
            proj.apiConfig.enabled = backendCfg.enabled;
          }
        }
      }
    } catch (e) {
      console.warn('[pull] Failed to pull project configs:', e.message);
    }
  }

  async function reconcileFromBackend() {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    if (!proj) return;
    try {
      var resp = await fetch(AppCore.BACKEND_URL + '/api/projects/sync-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: proj.id })
      });
      var data = await resp.json();
      if (data.config && data.config.enabled !== undefined) {
        if (!proj.apiConfig) proj.apiConfig = {};
        proj.apiConfig.enabled = data.config.enabled;
      }
      if (data.config && data.config._desireState) {
        var backendDS = data.config._desireState;
        if (!proj.desireSystem) {
          proj.desireSystem = {
            drives: { resonance: 0, exploration: 0, possession: 0, guardianship: 0, intimacy: 0, confirmation: 0, devotion: 0 },
            driveHistory: [], pendingActions: [], actionHistory: []
          };
        }
        if (backendDS.drives) {
          var mergedDrives = {};
          var keys = Object.keys(proj.desireSystem.drives);
          for (var k = 0; k < keys.length; k++) { mergedDrives[keys[k]] = proj.desireSystem.drives[keys[k]]; }
          var bdKeys = Object.keys(backendDS.drives);
          for (var k2 = 0; k2 < bdKeys.length; k2++) { mergedDrives[bdKeys[k2]] = backendDS.drives[bdKeys[k2]]; }
          proj.desireSystem.drives = mergedDrives;
        }
        if (backendDS.lastCheck) {
          proj.desireSystem.lastPassiveCheck = backendDS.lastCheck;
        }
        console.log('[reconcile] Desire state reconciled from backend:', JSON.stringify(proj.desireSystem.drives));
      }
      if (data.config && data.config._userStatus !== undefined && !proj._userStatus) {
        proj._userStatus = data.config._userStatus;
      }
      if (data.config && data.config._aiStatus !== undefined) {
        proj._aiStatus = data.config._aiStatus;
      }
      pollSystemEvents();
      store.projects.forEach(function(project) { pullChatMessages(project.id); });
      pollCloudData(proj.id);
      fetchTodosFromBackend(proj.id);
    } catch (e) {
      console.warn('[reconcile] Failed:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  Cloud polling
  // ═══════════════════════════════════════════
  function pollCloudData(projectId) {
    var diaryModule = AppCore.getModule('diary');
    if (diaryModule && diaryModule.syncPending) diaryModule.syncPending();
    if (!projectId) return;
    var store = AppCore.getStore();
    pullChatMessages(projectId);
    // Litter thoughts
    fetch(AppCore.BACKEND_URL + '/api/litter-thoughts?projectId=' + encodeURIComponent(projectId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.thoughts && data.thoughts.length) {
          var merged = false;
          for (var i = 0; i < data.thoughts.length; i++) {
            var t = data.thoughts[i];
            if (!store.litterThoughts.find(function(lt) { return lt.id === t.id; })
              && (!store._dismissedLitterIds || store._dismissedLitterIds.indexOf(t.id) === -1)) {
              store.litterThoughts.unshift({
                id: t.id, content: t.content, date: t.date, time: t.time,
                sourceChatId: t.chatId, sourceWindow: t.sourceWindow, _proactive: t.proactive
              });
              merged = true;
            }
          }
          if (merged) { store.litterThoughts.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); }); AppCore.saveStore(); }
        }
      }).catch(function() {});
    // Diary entries
    fetch(AppCore.BACKEND_URL + '/api/diary-entries?projectId=' + encodeURIComponent(projectId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.entries && data.entries.length) {
          var merged2 = false;
          for (var j = 0; j < data.entries.length; j++) {
            var e = data.entries[j];
            if (!store.diaries.find(function(d) { return d.id === e.id; })) {
              store.diaries.unshift({
                id: e.id, date: e.date, time: e.time, title: e.title,
                content: e.content, mood: e.mood, author: e.author,
                replies: e.replies || [], sourceChatId: e.chatId || '', sourceProjectId: e.projectId || projectId,
                visibilityMode: e.visibilityMode || 'selected', visibleChatIds: e.visibleChatIds || [],
                _proactive: e.proactive, createdAt: e.createdAt
              });
              merged2 = true;
            }
          }
          if (merged2) { store.diaries.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); }); AppCore.saveStore(); }
        }
      }).catch(function() {});
    pullDiaryDeliveries(projectId, store.activeChat);
  }

  function pullDiaryDeliveries(projectId, chatId) {
    if (!projectId || !chatId) return Promise.resolve();
    var store = AppCore.getStore();
    if (!Array.isArray(store.diaryDeliveries)) store.diaryDeliveries = [];
    return fetch(AppCore.BACKEND_URL + '/api/diary-deliveries?targetProjectId=' + encodeURIComponent(projectId) + '&targetChatId=' + encodeURIComponent(chatId))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        (data.deliveries || []).forEach(function(raw) {
          var d = { id: raw.id, diaryId: raw.diaryId || raw.diary_id, targetProjectId: raw.targetProjectId || raw.target_project_id, targetChatId: raw.targetChatId || raw.target_chat_id,
            deliveryType: raw.deliveryType || raw.delivery_type, status: raw.status, createdAt: raw.createdAt || raw.created_at, consumedAt: raw.consumedAt || raw.consumed_at };
          if (raw.diary && !store.diaries.some(function(x) { return x.id === raw.diary.id; })) {
            store.diaries.unshift({ id: raw.diary.id, date: raw.diary.date, time: raw.diary.time, title: raw.diary.title,
              content: raw.diary.content, mood: raw.diary.mood, author: raw.diary.author, sourceChatId: raw.diary.chatId || '', sourceProjectId: raw.diary.projectId || '',
              visibilityMode: raw.diary.visibilityMode || 'selected', visibleChatIds: raw.diary.visibleChatIds || [], replies: raw.diary.replies || [], createdAt: raw.diary.createdAt });
          }
          var old = store.diaryDeliveries.filter(function(x) { return x.id === d.id; })[0];
          if (old) { old.status = d.status; old.consumedAt = d.consumedAt; }
          else store.diaryDeliveries.push({ id: d.id, diaryId: d.diaryId, targetProjectId: d.targetProjectId, targetChatId: d.targetChatId,
            deliveryType: d.deliveryType, status: d.status, createdAt: d.createdAt, consumedAt: d.consumedAt });
        });
        AppCore.saveStore();
      }).catch(function() {});
  }

  // ═══════════════════════════════════════════
  //  Desire state sync
  // ═══════════════════════════════════════════
  async function syncDesireStateToBackend(force) {
    var store = AppCore.getStore();
    var proj = getActiveProject(); if (!proj || !proj.desireSystem) return;
    var ds = proj.desireSystem;
    var chat = getActiveChatObj();
    try {
      var since = store._lastEventPoll || '';
      var resp = await fetch(AppCore.BACKEND_URL + '/api/system-events?projectId=' + encodeURIComponent(proj.id) + '&since=' + encodeURIComponent(since));
      var data = await resp.json();
      if (data.events && data.events.length) {
        for (var i = 0; i < data.events.length; i++) {
          var evt = data.events[i];
          if (evt.driveKey && evt.postDecayValue !== undefined && evt.postDecayValue !== null && proj.desireSystem && proj.desireSystem.drives) {
            if (proj.desireSystem.drives[evt.driveKey] > evt.postDecayValue) {
              console.log('[sync-desire] Applying post-decay before sync:', evt.driveKey, proj.desireSystem.drives[evt.driveKey], '→', evt.postDecayValue);
              proj.desireSystem.drives[evt.driveKey] = evt.postDecayValue;
            }
          }
        }
      }
    } catch (e) { /* non-critical */ }

    var syncDrives = {};
    for (var dk in ds.drives) { if (dk !== 'confirmation') syncDrives[dk] = ds.drives[dk]; }
    var desireState = { drives: syncDrives, lastCheck: ds.lastPassiveCheck };
    if (ds._frontendTriggerTime) {
      desireState._frontendTriggerTime = ds._frontendTriggerTime;
      desireState._frontendTriggerDrive = ds._frontendTriggerDrive;
    }
    fetch(AppCore.BACKEND_URL + '/api/projects/sync-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: proj.id, config: { _desireState: desireState, _chatId: chat ? chat.id : '' } })
    }).then(function(r) {
      if (ds._justTriggered) { ds._justTriggered = false; AppCore.saveStore(); }
    }).catch(function(e) { console.warn('[sync-desire] Failed:', e.message); });
  }

  // ═══════════════════════════════════════════
  //  System events polling
  // ═══════════════════════════════════════════
  function pollSystemEvents() {
    var store = AppCore.getStore();
    if (!store.projects.length) return;
    var activeProj = getActiveProject();
    var activeChanged = false;
    var projects = store.projects.filter(function(proj) { return !proj._eventPollInFlight; });
    var pending = projects.length;
    if (!pending) return;

    function processEvents(proj, events) {
      if (!Array.isArray(proj._processedEventIds)) proj._processedEventIds = [];
      for (var i = 0; i < events.length; i++) {
        var evt = events[i];
        if (evt.id && proj._processedEventIds.indexOf(String(evt.id)) >= 0) continue;
        if (evt.id) {
          proj._processedEventIds.push(String(evt.id));
          if (proj._processedEventIds.length > 500) proj._processedEventIds.shift();
        }
        var chat = proj.chats.find(function(c) { return c.id === evt.chatId; });
        if (!chat) chat = proj.chats[proj.chats.length - 1];
        if (evt.type === 'todo') {
          if (evt.todoTitle && evt.todoId) {
            if (!store.todos.find(function(t) { return t.id === evt.todoId; })) {
              store.todos.unshift({ id: evt.todoId, text: evt.todoTitle, done: false, time: evt.timestamp, type: 'short', creator: 'ai', chatId: evt.chatId || '', createdAt: evt.timestamp, projectId: proj.id });
              AppCore.saveStore();
            }
          } else if (evt.content) {
            var todoMatch = evt.content.match(/\[\[TODO:([^\]|]+)(?:\|([^\]]+))?\]\]/);
            if (todoMatch) {
              var newId = 't' + AppCore.gid('');
              store.todos.unshift({ id: newId, text: todoMatch[1].trim(), done: false, time: todoMatch[2] || '--:--', type: 'short', creator: 'ai', chatId: evt.chatId || '', createdAt: evt.timestamp, projectId: proj.id });
              AppCore.saveStore();
            }
          }
        } else if (evt.type === 'litter') {
          if (evt.content) {
            var litterText = evt.content.replace(/^LITTER:\s*/i, '').trim();
            if (litterText) {
              if (!store.litterThoughts.some(function(lt) { return lt._eventId === evt.id; })) {
                store.litterThoughts.unshift({ id: 'lt' + AppCore.gid(''), content: litterText, date: evt.timestamp.slice(0, 10), time: toLocalDisplayTime(evt.timestamp), sourceChatId: evt.chatId || '', sourceWindow: chat ? chat.name || '' : '', _proactive: true, _eventId: evt.id });
              }
            }
          }
        } else if (evt.type === 'diary') {
        } else if (evt.type === 'todo_wake') {
          if (evt.todoId) {
            var todo = store.todos.find(function(t2) { return t2.id === evt.todoId; });
            if (todo) { todo.triggered = true; AppCore.saveStore(); }
          }
        } else if (evt.type === 'ai_status_change') {
          if (evt.content) {
            proj._aiStatus = evt.content;
            proj._aiStatusChanged = true;
            AppCore.saveStore();
          }
        }
        if (evt.driveKey && evt.postDecayValue !== undefined && evt.postDecayValue !== null && proj.desireSystem && proj.desireSystem.drives) {
          proj.desireSystem.drives[evt.driveKey] = evt.postDecayValue;
        }
        if (proj === activeProj) activeChanged = true;
      }
    }

    for (var pi = 0; pi < projects.length; pi++) {
      (function(proj) {
        proj._eventPollInFlight = true;
        if (!proj._lastEventPoll) {
          proj._lastEventPoll = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        }
        var since = proj._lastEventPoll;
        var fetchedEvents = [];
        var pollSucceeded = false;
        fetch(AppCore.BACKEND_URL + '/api/system-events?projectId=' + encodeURIComponent(proj.id) + '&since=' + encodeURIComponent(since))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            pollSucceeded = true;
            fetchedEvents = data.events || [];
            if (fetchedEvents.length) processEvents(proj, fetchedEvents);
            pullChatMessages(proj.id);
          }).catch(function() {})
          .finally(function() {
            proj._eventPollInFlight = false;
            if (pollSucceeded) {
              var maxTimestamp = fetchedEvents.reduce(function(max, evt) {
                return evt.timestamp && evt.timestamp > max ? evt.timestamp : max;
              }, '');
              var cursorTime = maxTimestamp ? new Date(maxTimestamp).getTime() : Date.now();
              proj._lastEventPoll = new Date(cursorTime - 1000).toISOString();
            }
            pending--;
            if (pending === 0) {
              AppCore.saveStore();
              if (activeChanged && typeof renderChatMessages === 'function') renderChatMessages();
            }
          });
      })(store.projects[pi]);
    }
  }

  // ═══════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════
  function init() {
    console.log('[SyncModule] ✅ initialized');
    // Timers are set up by init() in index.html (called after AppCore.init)
    // This module only provides the functions; the calling code manages intervals.
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════
  return {
    init: init,

    syncTodosToBackend: syncTodosToBackend,
    fetchTodosFromBackend: fetchTodosFromBackend,
    buildChatContextSummary: buildChatContextSummary,
    syncProjectConfigToBackend: syncProjectConfigToBackend,
    syncMessagesToBackend: syncMessagesToBackend,
    scheduleMessageSync: scheduleMessageSync,
    pullChatMessages: pullChatMessages,
    pullAllProjectEnabledStates: pullAllProjectEnabledStates,
    reconcileFromBackend: reconcileFromBackend,
    pollCloudData: pollCloudData,
    pullDiaryDeliveries: pullDiaryDeliveries,
    syncDesireStateToBackend: syncDesireStateToBackend,
    pollSystemEvents: pollSystemEvents
  };
})();

// Register with AppCore
AppCore.register('sync', SyncModule);
