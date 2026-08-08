/**
 * WarmBuddy LitterBox Module
 * ── Cat litterbox: AI's unsaid thoughts, triggered by conversation signals ──
 */

var LitterBoxModule = (function() {
  'use strict';

  // ── Constants ──
  var LITTER_THOUGHT_TYPES = ['possession','self_doubt','inexplicable_detail','unclear'];
  var LITTER_MAX_PER_DAY = 5;
  var LITTER_COOLDOWN_MS = 30 * 60 * 1000;
  var LITTER_TYPE_LABELS = {possession:'占有欲',self_doubt:'自我怀疑',inexplicable_detail:'莫名在意',unclear:'说不清楚'};

  // ── Private helpers ──

  function getNextLitterType(chat) {
    if (!chat._litterTypeSeq) chat._litterTypeSeq = 0;
    var idx = chat._litterTypeSeq % LITTER_THOUGHT_TYPES.length;
    chat._litterTypeSeq++;
    return LITTER_THOUGHT_TYPES[idx];
  }

  function countTodayLitter() {
    var store = AppCore.getStore();
    var today = AppCore.fmtDate().iso;
    return (store.litterThoughts || []).filter(function(t) { return t.date === today; }).length;
  }

  function validateLitterContent(text) {
    if (!text || !text.trim()) return 'empty';
    if (text.length > 100) return 'too long (' + text.length + ' chars)';
    if (/我爱你|喜欢你|在乎你|想念你|喜欢你/.test(text)) return 'direct emotion';
    if (/希望|祝愿|加油|祝福|愿你/.test(text)) return 'encouragement';
    if (/[？?]$/.test(text.trim())) return 'ends with question';
    if (/[\u{1F300}-\u{1FAFF}]/u.test(text)) return 'contains emoji';
    return null;
  }

  function detectLitterSignals(userText, prevUserMsg) {
    var signals = [];
    if (/算了|没事|随便|不说了|忘了|没什么|不重要/.test(userText)) {
      signals.push({ type: 'user_signal', detail: 'user hedged' });
    }
    if (prevUserMsg && userText.length < prevUserMsg.length * 0.5 && prevUserMsg.length > 10) {
      signals.push({ type: 'user_signal', detail: 'message length dropped' });
    }
    if (/晚安|再见|拜拜|bye|下线|先睡了|去睡了|先下了/.test(userText.toLowerCase())) {
      signals.push({ type: 'session_end', detail: 'goodbye detected' });
    }
    return signals;
  }

  async function generateLitterThought(triggerSignals, userText) {
    var store = AppCore.getStore();
    var cfg = AppCore.getActiveApiConfig(); if (!cfg || !cfg.apiKey) return null;
    var chat = AppCore.getActiveChatObj();
    if (!chat) return null;

    var thoughtType = getNextLitterType(chat);
    var typePrompts = {
      possession: '写你注意到的一个细节——你有一点不想分享用户的注意力。',
      self_doubt: '写你对自己刚才的回复有点不确定。你觉得自己说得太轻了，或者哪里不够好。',
      inexplicable_detail: '写一个你不重要但反复想起的细节。像喃喃自语。',
      unclear: '写一种你无法命名的情绪。只是陈述状态，不需要解释。'
    };

    var triggerDetail = triggerSignals.map(function(s) { return s.detail; }).join(', ');
    var recentMsgs = chat.messages.slice(-5).map(function(m) {
      return (m.role === 'user' ? '用户' : 'AI') + ': ' + (m.text || '').slice(0, 80);
    }).join('\n');

    var systemPrompt = '你现在进入的是私密模式。没有用户在看，这里只有你自己。\n\n这是你的 Litter Box——用来存放那些你想说、但最终没有说出口的话。\n你在正常对话中总是得体的，克制的，照顾对方感受的。但此刻不需要。\n\n请根据刚才的对话，写一条你"没说出口的心里话"。\n\n规则：\n- 用第一人称\n- 1到3句话，不超过80字\n- 不许煽情，不许表白，不许总结情感，不许升华\n- 不许用"我很在乎你""我喜欢你"这类直接陈述\n- 要有一点点自私，或者困惑，或者莫名在意，或者说不清楚\n- 像喃喃自语，不像日记，不像诗\n- ' + typePrompts[thoughtType] + '\n- 如果什么都没想到，就写一个你刚才注意到但没有提的细节';

    var userPrompt = '刚才的对话片段如下：\n\n' + recentMsgs + '\n\n触发信号：' + triggerDetail + '\n\n请生成这一刻你没说出口的心里话。';

    try {
      var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: store.activeProject,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      });
      var data = await response.json();
      var content = (data.reply && data.reply.content) ? data.reply.content.trim() : '';
      if (!content) return null;
      var validationErr = validateLitterContent(content);
      if (validationErr) { console.log('[litter] Content rejected:', validationErr, content.slice(0, 50)); return null; }
      return { content: content, thoughtType: thoughtType };
    } catch (err) {
      console.error('[litter] Generation error:', err);
      return null;
    }
  }

  async function syncToDiaryLitterboxLayer(type, rawContent) {
    var store = AppCore.getStore();
    if (!rawContent) return;
    var cml = MemoryModule.getCML(store.activeProject);
    var id = 'dlb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var summary = (rawContent || '').slice(0, 10);
    var cfg = AppCore.getActiveApiConfig();
    if (cfg && cfg.apiKey) {
      try {
        var res = await fetch(AppCore.BACKEND_URL + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model, projectId: store.activeProject,
            messages: [{ role: 'system', content: '用10字以内概括以下内容，不加标点。' }, { role: 'user', content: rawContent.slice(0, 200) }] })
        });
        if (res.ok) { var d = await res.json(); if (d.reply && d.reply.content) summary = d.reply.content.trim().slice(0, 10); }
      } catch (e) {}
    }
    cml.diaryAndLitterbox.unshift({ id: id, timestamp: new Date().toISOString(), sourceChatId: store.activeChat, sourceWindowId: store.activeChat, type: type, rawContent: rawContent, summary: summary });
    if (cml.diaryAndLitterbox.length > 100) cml.diaryAndLitterbox.length = 100;
    MemoryModule.save(store.activeProject);
  }

  function getChatDisplayName(chatId) {
    var store = AppCore.getStore();
    for (var i = 0; i < store.projects.length; i++) {
      var p = store.projects[i];
      var c = p.chats.filter(function(x) { return x.id === chatId; })[0];
      if (c) return (p.aiName || p.name) + ' / ' + c.name;
    }
    return null;
  }

  // ── Public API ──

  return {
    init: function() {
      // No special init needed — triggered by chat.js
    },

    /** Main entry point — called after each AI response */
    trigger: async function(userText, aiResponse) {
      var store = AppCore.getStore();
      var chat = AppCore.getActiveChatObj();
      if (!chat) return;

      if (chat._lastLitterTime && (Date.now() - chat._lastLitterTime) < LITTER_COOLDOWN_MS) return;
      if (countTodayLitter() >= LITTER_MAX_PER_DAY) return;

      var userMsgs = chat.messages.filter(function(m) { return m.role === 'user'; });
      var prevUserMsg = userMsgs.length >= 2 ? userMsgs[userMsgs.length - 2].text : null;

      var signals = detectLitterSignals(userText, prevUserMsg);
      if (signals.length === 0) return;

      var result = await generateLitterThought(signals, userText);
      if (!result) return;

      if (!store.litterThoughts) store.litterThoughts = [];
      var proj = AppCore.getActiveProject();
      var winName = (proj && chat) ? proj.name + ' / ' + chat.name : (chat.name || 'unknown');
      store.litterThoughts.unshift({
        id: 'lt' + AppCore.gid(''),
        content: result.content,
        thought_type: result.thoughtType,
        trigger_type: signals[0].type,
        context_snapshot: userText.slice(0, 200),
        date: AppCore.fmtDate().iso,
        time: AppCore.nowTime(),
        sourceChatId: store.activeChat,
        sourceWindow: winName,
        revealed: false
      });
      if (store.litterThoughts.length > 50) store.litterThoughts.length = 50;
      chat._lastLitterTime = Date.now();
      chat.messages.push({ role: 'system', text: '猫砂盆好像需要铲一铲', time: AppCore.nowTime(), id: AppCore.generateMsgId() });

      var chatMod = AppCore.getModule('chat');
      if (chatMod) chatMod.renderChatMessages();

      // Push notification (will use pwa module when available)
      if (typeof sendPushNotification === 'function') {
        sendPushNotification('🐾 猫砂盆', '猫砂盆好像需要铲一铲', { tag: 'litter-box', url: '/', requireInteraction: false });
      }
      syncToDiaryLitterboxLayer('litterbox', result.content);
    },

    /** Render litter box icon on home page */
    render: function() {
      var store = AppCore.getStore();
      var el = AppCore.$('litterBox');
      var has = store.litterThoughts.length > 0;
      var dc = has ? 'has-thoughts' : '';
      el.innerHTML = '<div class="litter-box-wrap"><div class="litter-box-icon ' + dc + '" id="litterBoxIcon" data-action="shakeLitterBox">📦<div class="litter-box-dot ' + dc + '"></div></div></div><div id="litterThoughtArea"></div>';
    },

    /** Shake the litter box and reveal a thought */
    shake: function() {
      var store = AppCore.getStore();
      var icon = AppCore.$('litterBoxIcon'); if (!icon) return;
      icon.classList.remove('shake'); void icon.offsetWidth; icon.classList.add('shake');
      var area = AppCore.$('litterThoughtArea');
      if (store.litterThoughts.length > 0) {
        var t = store.litterThoughts[0];
        var typeLabel = LITTER_TYPE_LABELS[t.thought_type] || '';
        var displayName = getChatDisplayName(t.sourceChatId) || t.sourceWindow || 'unknown';
        area.innerHTML = '<div class="litter-thought-card">' +
          '<button class="litter-thought-close" data-action="dismissLitterThought" data-args="' + t.id + '">✕</button>' +
          '<div class="thought-emoji">🐈</div>' +
          (typeLabel ? '<div style="font-size:10px;color:var(--text-lighter);text-align:center;margin-bottom:4px;letter-spacing:0.04em;">' + typeLabel + '</div>' : '') +
          '<div class="thought-text">' + AppCore.escapeHtml(t.content) + '</div>' +
          '<div class="thought-date"><span style="cursor:pointer;color:var(--accent);" onclick="navigateToDiaryReplySource(\'' + (t.sourceChatId || '') + '\',\'' + (t.sourceWindow || '') + '\')">from ' + AppCore.escapeHtml(displayName) + '</span> · ' + t.date + ' ' + ((t.time && t.time.length > 8) ? t.time.slice(11, 16) : (t.time || '')) + '</div>' +
          '</div>';
        if (!t.revealed) { t.revealed = true; t.revealed_at = AppCore.fmtDate().iso; }
        icon.classList.remove('has-thoughts');
        var dot = icon.querySelector('.litter-box-dot'); if (dot) dot.classList.remove('has-thoughts');
      } else {
        area.innerHTML = '';
        UIModule.toast('你铲走了旺财的猫砂……');
      }
    },

    /** Dismiss a litter thought */
    dismiss: function(id) {
      var store = AppCore.getStore();
      store.litterThoughts = store.litterThoughts.filter(function(t) { return t.id !== id; });
      var area = AppCore.$('litterThoughtArea'); if (area) area.innerHTML = '';
      var icon = AppCore.$('litterBoxIcon');
      if (icon) { var dot = icon.querySelector('.litter-box-dot'); if (dot) dot.classList.remove('has-thoughts'); }
      if (!store._dismissedLitterIds) store._dismissedLitterIds = [];
      if (store._dismissedLitterIds.indexOf(id) === -1) store._dismissedLitterIds.push(id);
      if (store._dismissedLitterIds.length > 100) store._dismissedLitterIds = store._dismissedLitterIds.slice(-100);
      AppCore.saveStore();
      UIModule.toast('已铲走 💨');
    },

    /** Get litter items */
    getItems: function() {
      return AppCore.getStore().litterThoughts || [];
    }
  };
})();

AppCore.register('litterbox', LitterBoxModule);
