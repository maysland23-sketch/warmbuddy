/**
 * WarmBuddy Diary Module
 * ── Diary entries, replies, calendar, and AI auto-comment ──
 */

var DiaryModule = (function() {
  'use strict';

  var MOOD_MAP = {
    calm:     { label: '平静',   cls: 'calm' },
    excited:  { label: '兴奋',   cls: 'excited' },
    troubled: { label: '烦恼',   cls: 'troubled' }
  };
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // ── Helpers ──

  function getChatDisplayName(chatId) {
    var store = AppCore.getStore();
    for (var i = 0; i < store.projects.length; i++) {
      var p = store.projects[i];
      var c = p.chats.filter(function(x) { return x.id === chatId; })[0];
      if (c) return (p.aiName || p.name) + ' / ' + c.name;
    }
    return null;
  }

  function diaryApi(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(AppCore.BACKEND_URL + path, opts);
  }

  function syncEntry(entry) {
    if (!entry || entry._cloudOnly) return;
    entry._syncPending = true;
    diaryApi('POST', '/api/diary-entries', {
      id: entry.id, projectId: entry.sourceProjectId || AppCore.getStore().activeProject,
      chatId: entry.sourceChatId || '', date: entry.date, time: entry.time,
      title: entry.title, content: entry.content, mood: entry.mood, author: entry.author,
      proactive: !!entry._proactive, createdAt: entry.createdAt,
      visibilityMode: entry.visibilityMode || 'selected', visibleChatIds: entry.visibleChatIds || [], replies: entry.replies || []
    }).then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); entry._syncPending = false; AppCore.saveStore(); var chat = AppCore.getModule('chat'); if (chat && chat.invalidateDynamicContext) chat.invalidateDynamicContext(); })
      .catch(function(e) { console.warn('[diary-sync] failed:', e.message); });
  }

  function addDelivery(entryId, projectId, chatId, type) {
    var d = { id: 'dd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), diaryId: entryId, targetProjectId: projectId, targetChatId: chatId, deliveryType: type || 'share', status: 'pending', createdAt: new Date().toISOString() };
    var store = AppCore.getStore();
    if (!store.diaryDeliveries) store.diaryDeliveries = [];
    store.diaryDeliveries.push(d);
    d._syncPending = true;
    diaryApi('POST', '/api/diary-deliveries', d).then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); d._syncPending = false; AppCore.saveStore(); }).catch(function(e) { console.warn('[diary-share] failed:', e.message); });
    return d;
  }

  function chatSelectionMarkup(className, selectedIds) {
    var store = AppCore.getStore();
    var selected = selectedIds || [];
    var html = '<div class="diary-chat-select-list">';
    store.projects.forEach(function(p) {
      if (!(p.chats || []).length) return;
      html += '<div class="diary-chat-select-project">' + AppCore.escapeHtml(p.name || 'project') + '</div>';
      (p.chats || []).forEach(function(c) {
        var checked = selected.indexOf(c.id) >= 0;
        html += '<div class="chat-select-item diary-chat-select-item" onclick="this.querySelector(\'.' + className + '\').classList.toggle(\'checked\')">' +
          '<div class="chat-select-check ' + className + (checked ? ' checked' : '') + '" data-chat-id="' + c.id + '"></div>' +
          '<span class="chat-select-name">' + AppCore.escapeHtml(c.name || 'window') + '</span>' +
          '<span class="chat-select-project">' + AppCore.escapeHtml(p.name || '') + '</span></div>';
      });
    });
    return html + '</div>';
  }

  function toggleDiaryVisibilityMode(mode) {
    var list = document.querySelector('.diary-chat-select-list');
    if (!list) return;
    list.classList.toggle('disabled', mode === 'public');
    list.querySelectorAll('.diaryVisibleChatCheck').forEach(function(el) { el.classList.toggle('checked', mode === 'public'); });
  }

  function syncPending() {
    var store = AppCore.getStore();
    (store.diaries || []).filter(function(d) { return d._syncPending && !d._deleted; }).slice(0, 10).forEach(syncEntry);
    (store.diaryDeliveries || []).filter(function(d) { return d._syncPending && d.status === 'pending'; }).slice(0, 20).forEach(function(d) {
      diaryApi('POST', '/api/diary-deliveries', d).then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); d._syncPending = false; AppCore.saveStore(); }).catch(function() {});
    });
  }

  function visibilityOptions() {
    var store = AppCore.getStore();
    return '<div class="diary-selector-intro">\u53ef\u89c1\u8303\u56f4</div>' +
      '<label class="diary-visibility-option"><input type="radio" name="diaryVisibility" value="selected" checked onclick="toggleDiaryVisibilityMode(this.value)"> \u6307\u5b9a\u7a97\u53e3</label>' +
      '<label class="diary-visibility-option"><input type="radio" name="diaryVisibility" value="public" onclick="toggleDiaryVisibilityMode(this.value)"> \u516c\u5f00\uff08\u73b0\u6709\u6240\u6709\u7a97\u53e3\uff09</label>' +
      chatSelectionMarkup('diaryVisibleChatCheck', [store.activeChat]);
    var html = '<div style="font-size:12px;color:var(--text-light);margin:4px 0 8px;">可见范围</div>';
    html += '<label style="display:block;font-size:12px;margin:6px 0;"><input type="radio" name="diaryVisibility" value="selected" checked> 指定窗口</label>';
    html += '<label style="display:block;font-size:12px;margin:6px 0;"><input type="radio" name="diaryVisibility" value="public"> 公开（现有所有窗口）</label>';
    html += '<div style="max-height:120px;overflow:auto;padding:4px 0;">';
    for (var i = 0; i < store.projects.length; i++) for (var j = 0; j < (store.projects[i].chats || []).length; j++) {
      var p = store.projects[i], c = p.chats[j];
      html += '<label style="display:block;font-size:11px;margin:4px 0;"><input type="checkbox" name="diaryVisibleChat" value="' + c.id + '"' + (c.id === store.activeChat ? ' checked' : '') + '> ' + AppCore.escapeHtml((p.name || '') + ' / ' + (c.name || '')) + '</label>';
    }
    return html + '</div>';
  }

  // ── Public API ──

  return {
    init: function() { window.toggleDiaryVisibilityMode = toggleDiaryVisibilityMode; },

    syncEntry: syncEntry,
    addDelivery: addDelivery,
    syncPending: syncPending,

    /** Render the diary panel for the selected date */
    render: function() {
      var store = AppCore.getStore();
      var selDate = store.diarySelectedDate || AppCore.fmtDate().iso;
      var parts = selDate.split('-').map(Number);
      var dObj = new Date(parts[0], parts[1]-1, parts[2]);
      var sd = parts[2];

      AppCore.$('diaryDateArt').innerHTML = '<div class="diary-date-day">' + sd + '</div><div class="diary-date-mon">' + MONTHS[parts[1]-1] + ' ' + parts[0] + '</div><div class="diary-date-click-hint">tap to browse</div>';

      var dayEntries = store.diaries.filter(function(d) { return d.date === selDate && !d._deleted && !d.deletedAt; });
      dayEntries.sort(function(a, b) { return a.time.localeCompare(b.time); });

      var todayIso = AppCore.fmtDate().iso;
      var hasUserEntryToday = store.diaries.some(function(d) { return d.date === selDate && d.author === 'user'; });
      var promptEl = AppCore.$('diaryTodayPrompt');
      if (selDate === todayIso) {
        var promptText = hasUserEntryToday ? '还想写点什么……' : '写点什么吧……';
        promptEl.innerHTML = '<div class="diary-today-prompt" data-action="addDiaryEntry"><div class="diary-today-prompt-text">' + promptText + '</div></div>';
      } else {
        promptEl.innerHTML = '';
      }

      var html = '';
      if (dayEntries.length === 0) {
        html = '<div class="empty-state">no entries for this date.</div>';
      } else {
        var self = this;
        dayEntries.forEach(function(d) {
          var isAI = d.author === 'ai';
          var title = d.title || d.content.slice(0, 20) + (d.content.length > 20 ? '…' : '');
          var displayName = d.sourceChatId ? getChatDisplayName(d.sourceChatId) : null;
          var byLine = isAI
            ? (displayName ? '<span class="diary-reply-source" onclick="event.stopPropagation();navigateToDiaryReplySource(\'' + (d.sourceChatId || '') + '\', \'' + (displayName || '') + '\')">from ' + AppCore.escapeHtml(displayName) + '</span>' : 'from ai')
            : 'By ' + AppCore.USER_NAME;
          var moodInfo = MOOD_MAP[d.mood] || { label: d.mood || '平静', cls: 'calm' };
          html += '<div class="diary-card-entry ' + (isAI ? 'ai-entry' : '') + '">' +
            '<div class="diary-card-title" id="diary-entry-' + d.id + '" style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span>' + AppCore.escapeHtml(title) + '</span>' +
              '<span style="display:flex;gap:8px;align-items:center;"><span style="font-size:12px;color:var(--text-lighter);cursor:pointer;" data-action="shareDiaryEntry" data-args="' + d.id + '" title="分享">share</span><span style="font-size:14px;color:var(--text-lighter);cursor:pointer;padding:2px 4px;" data-action="editDiaryEntry" data-args="' + d.id + '" title="编辑 / 删除">✎</span></span>' +
            '</div>' +
            '<div class="diary-card-mood-row">' +
              '<span class="diary-card-mood-tag ' + moodInfo.cls + '">' + moodInfo.label + '</span>' +
              '<span class="diary-card-time">' + (d.time || '') + '</span>' +
            '</div>' +
            '<div class="diary-card-content">' + d.content + '</div>' +
            '<div class="diary-card-by">' + byLine + '</div>' +
            '<div class="diary-reply-area">' +
              (d.replies || []).map(function(r) {
                var rDisplayName = r.sourceChatId ? getChatDisplayName(r.sourceChatId) : null;
                var rBy = r.author === 'ai'
                  ? (rDisplayName ? '<span class="diary-reply-source" onclick="event.stopPropagation();navigateToDiaryReplySource(\'' + (r.sourceChatId || '') + '\', \'' + (rDisplayName || '') + '\')">from ' + AppCore.escapeHtml(rDisplayName) + '</span>' : 'from ai')
                  : AppCore.USER_NAME;
                return '<div class="diary-reply-item ' + (r.author === 'ai' ? 'ai-reply' : 'user-reply') + '">' +
                  '<div class="diary-reply-content">' + r.content + '</div>' +
                  '<div class="diary-reply-meta">' + rBy + ' · ' + r.date + ' ' + r.time + '</div>' +
                '</div>';
              }).join('') +
              '<div class="diary-reply-tap" data-action="addDiaryReply" data-args="' + d.id + '">' +
                ((d.replies || []).length === 0 ? 'tap to leave a message...' : 'reply...') +
              '</div>' +
            '</div>' +
          '</div>';
        });
      }
      AppCore.$('diaryEntries').innerHTML = html;
    },

    /** Add a reply to a diary entry */
    addReply: function(entryId) {
      var store = AppCore.getStore();
      UIModule.showModal('Leave a Message',
        '<p style="font-size:12px;color:var(--text-lighter);margin-bottom:10px;">回复此日记</p>' +
        '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
          '<button style="padding:5px 16px;border-radius:16px;border:1px solid var(--border);background:transparent;font-family:var(--font-en);font-size:12px;color:var(--text-light);cursor:pointer;" id="replyAuthorBtn" data-action="toggleReplyAuthor" data-author="user">by: user</button>' +
        '</div>' +
        '<textarea class="modal-input modal-textarea" id="replyInput" placeholder="Write a message..."></textarea>' +
        '<input type="hidden" id="replyEntryId" value="' + entryId + '">' +
        '<input type="hidden" id="replyAuthor" value="user">',
        [
          { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
          { label: 'send', cls: 'confirm', onclick: function() { DiaryModule.saveReply(); } }
        ]
      );
    },

    /** Toggle reply author (user/ai) */
    toggleReplyAuthor: function() {
      var btn = AppCore.$('replyAuthorBtn');
      var c = btn.dataset.author;
      var n = c === 'user' ? 'ai' : 'user';
      btn.dataset.author = n;
      btn.textContent = 'by: ' + n;
      AppCore.$('replyAuthor').value = n;
    },

    /** Save a diary reply */
    saveReply: function() {
      var store = AppCore.getStore();
      var entryId = AppCore.$('replyEntryId').value;
      var content = AppCore.$('replyInput').value.trim();
      var author = AppCore.$('replyAuthor').value;
      if (!content) { UIModule.toast('Please write something'); return; }
      var entry = store.diaries.filter(function(d) { return d.id === entryId; })[0];
      if (!entry) return;
      if (!entry.replies) entry.replies = [];
      var now = new Date();
      entry.replies.push({
        id: 'r' + AppCore.gid(''),
        content: content, author: author,
        date: AppCore.fmtDate().iso,
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
      });
      store._importing = true;
      UIModule.closeModal();
      DiaryModule.render();
      UIModule.toast('Reply sent');
      syncEntry(entry);
    },

    /** Open the edit diary entry modal */
    editEntry: function(entryId) {
      var store = AppCore.getStore();
      var entry = store.diaries.filter(function(d) { return d.id === entryId; })[0];
      if (!entry) return;
      var moodOpts = [{v:'calm',l:'平静'},{v:'excited',l:'兴奋'},{v:'troubled',l:'烦恼'}];
      UIModule.showModal('编辑日记',
        '<input class="modal-input" id="editDiaryTitle" value="' + (entry.title || '') + '" placeholder="Title (optional)">' +
        '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
          moodOpts.map(function(m) {
            return '<button class="mood-tag' + (entry.mood === m.v ? ' selected' : '') + '" data-mood-val="' + m.v + '" data-action="selectMoodInModal" data-args="' + m.v + '" style="font-size:12px;padding:4px 14px;">' + m.l + '</button>';
          }).join('') +
        '</div>' +
        '<textarea class="modal-input modal-textarea" id="editDiaryContent" placeholder="Today...">' + (entry.content || '') + '</textarea>' +
        '<input type="hidden" id="editDiaryId" value="' + entryId + '">' +
        '<input type="hidden" id="editDiaryMood" value="' + (entry.mood || 'calm') + '">',
        [
          { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
          { label: 'delete', cls: 'danger', onclick: function() { DiaryModule.confirmDeleteEntry(); } },
          { label: 'save', cls: 'confirm', onclick: function() { DiaryModule.saveEdit(); } }
        ]
      );
      setTimeout(function() {
        var ft = document.querySelector('#modalBody .mood-tag[data-mood-val="' + (entry.mood || 'calm') + '"]');
        if (ft) ft.classList.add('selected');
      }, 50);
    },

    /** Confirm and delete a diary entry */
    confirmDeleteEntry: function() {
      var store = AppCore.getStore();
      var entryId = AppCore.$('editDiaryId').value;
      var deletedEntry = store.diaries.filter(function(d) { return d.id === entryId; })[0];
      if (deletedEntry) deletedEntry._deleted = true;
      (store.diaryDeliveries || []).forEach(function(d) { if (d.diaryId === entryId && d.status === 'pending') d.status = 'cancelled'; });
      diaryApi('DELETE', '/api/diary-entries/' + encodeURIComponent(entryId)).catch(function(e) { console.warn('[diary-sync] delete failed:', e.message); });
      store._importing = true;
      UIModule.closeModal();
      DiaryModule.render();
      UIModule.toast('日记已删除');
    },

    /** Save edited diary entry */
    saveEdit: function() {
      var store = AppCore.getStore();
      var entryId = AppCore.$('editDiaryId').value;
      var entry = store.diaries.filter(function(d) { return d.id === entryId; })[0];
      if (!entry) return;
      var titleEl = AppCore.$('editDiaryTitle');
      entry.title = (titleEl ? titleEl.value : '').trim();
      entry.content = AppCore.$('editDiaryContent').value.trim();
      entry.mood = AppCore.$('editDiaryMood').value;
      if (!entry.content) { UIModule.toast('Please write something'); return; }
      store._importing = true;
      UIModule.closeModal();
      DiaryModule.render();
      UIModule.toast('日记已更新');
      syncEntry(entry);
    },

    /** Share a diary entry to one or more target windows. */
    shareEntry: function(entryId) {
      var store = AppCore.getStore();
      var entry = store.diaries.filter(function(d) { return d.id === entryId; })[0];
      if (!entry) return;
      var html = '<div class="diary-selector-intro">选择要发送到的窗口</div>';
      html = html + chatSelectionMarkup('diaryShareChatCheck', []) + '<input type="hidden" id="shareDiaryId" value="' + entryId + '">';
      UIModule.showModal('分享日记', html, [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'confirm', cls: 'confirm', onclick: function() { DiaryModule.confirmShare(); } }
      ]);
    },

    confirmShare: function() {
      var store = AppCore.getStore();
      var entryId = AppCore.$('shareDiaryId').value;
      var ids = Array.prototype.slice.call(document.querySelectorAll('.diaryShareChatCheck.checked')).map(function(el) { return el.getAttribute('data-chat-id'); });
      if (ids.length === 0) { UIModule.toast('请选择窗口'); return; }
      var first = null;
      for (var i = 0; i < ids.length; i++) for (var p = 0; p < store.projects.length; p++) {
        var chat = (store.projects[p].chats || []).filter(function(c) { return c.id === ids[i]; })[0];
        if (chat) {
          var d = addDelivery(entryId, store.projects[p].id, chat.id, 'share');
          if (!first) first = { projectId: store.projects[p].id, chatId: chat.id, delivery: d };
          break;
        }
      }
      UIModule.closeModal();
      if (first) {
        store.activeProject = first.projectId;
        store.activeChat = first.chatId;
        UIModule.closeAllPanels();
        UIModule.navigate('chat');
        var chatMod = AppCore.getModule('chat');
        if (chatMod && chatMod.renderChat) chatMod.renderChat();
        UIModule.toast('日记已分享');
      }
    },

    /** Add a new diary entry */
    addEntry: function() {
      var store = AppCore.getStore();
      var ds = store.diarySelectedDate || AppCore.fmtDate().iso;
      var moodOpts = [{v:'calm',l:'平静'},{v:'excited',l:'兴奋'},{v:'troubled',l:'烦恼'}];
      UIModule.showModal('New Diary Entry',
        '<div style="font-family:var(--font-en);font-size:13px;color:var(--text-lighter);margin-bottom:12px;">' + ds + '</div>' +
        '<input class="modal-input" id="newDiaryTitle" placeholder="Title (optional)">' +
        '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
          moodOpts.map(function(m) {
            return '<button class="mood-tag" data-mood-val="' + m.v + '" data-action="selectMoodInModal" data-args="' + m.v + '" style="font-size:12px;padding:4px 14px;">' + m.l + '</button>';
          }).join('') +
        '</div>' +
        '<textarea class="modal-input modal-textarea" id="newDiaryInput" placeholder="Today..."></textarea>' +
        visibilityOptions() +
        '<input type="hidden" id="newDiaryMood" value="calm">',
        [
          { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
          { label: 'save', cls: 'confirm', onclick: function() { DiaryModule.saveEntry(); } }
        ]
      );
      setTimeout(function() {
        var ft = document.querySelector('#modalBody .mood-tag[data-mood-val="calm"]');
        if (ft) ft.classList.add('selected');
      }, 50);
    },

    /** Select a mood in the modal */
    selectMood: function(mood) {
      var tags = document.querySelectorAll('#modalBody .mood-tag');
      for (var i = 0; i < tags.length; i++) { tags[i].classList.remove('selected'); }
      var activeBtn = document.querySelector('#modalBody .mood-tag[data-mood-val="' + mood + '"]');
      if (activeBtn) activeBtn.classList.add('selected');
      var moodInput = AppCore.$('newDiaryMood') || AppCore.$('editDiaryMood');
      if (moodInput) moodInput.value = mood;
    },

    /** Save a new diary entry */
    saveEntry: function() {
      var store = AppCore.getStore();
      var titleEl = AppCore.$('newDiaryTitle');
      var title = (titleEl ? titleEl.value : '').trim();
      var content = AppCore.$('newDiaryInput').value.trim();
      var mood = AppCore.$('newDiaryMood').value;
      if (!content) { UIModule.toast('Please write something'); return; }
      var ds = store.diarySelectedDate || AppCore.fmtDate().iso;
      var now = new Date();
      var visibilityMode = (document.querySelector('input[name="diaryVisibility"]:checked') || {}).value || 'selected';
      var visibleChatIds = Array.prototype.slice.call(document.querySelectorAll('.diaryVisibleChatCheck.checked')).map(function(el) { return el.getAttribute('data-chat-id'); });
      if (visibleChatIds.length === 0) visibleChatIds = [store.activeChat];
      if (visibilityMode === 'public') {
        visibleChatIds = [];
        store.projects.forEach(function(p) { (p.chats || []).forEach(function(c) { visibleChatIds.push(c.id); }); });
      }
      var entry = {
        id: 'd' + AppCore.gid(''), date: ds,
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        title: title, content: content, mood: mood, author: 'user', replies: [],
        sourceChatId: store.activeChat, sourceProjectId: store.activeProject,
        visibilityMode: visibilityMode, visibleChatIds: visibleChatIds,
        createdAt: now.toISOString()
      };
      store.diaries.unshift(entry);
      if (visibilityMode === 'public') {
        for (var pi = 0; pi < store.projects.length; pi++) for (var ci = 0; ci < (store.projects[pi].chats || []).length; ci++) addDelivery(entry.id, store.projects[pi].id, store.projects[pi].chats[ci].id, 'visibility');
      } else {
        for (var vi = 0; vi < visibleChatIds.length; vi++) {
          for (var pj = 0; pj < store.projects.length; pj++) {
            var target = (store.projects[pj].chats || []).filter(function(c) { return c.id === visibleChatIds[vi]; })[0];
            if (target) { addDelivery(entry.id, store.projects[pj].id, target.id, 'visibility'); break; }
          }
        }
      }
      store._importing = true;
      UIModule.closeModal();
      DiaryModule.render();
      UIModule.toast('Diary saved');
      syncEntry(entry);
    },

    /** Navigate to the source chat of a diary reply */
    navigateToDiaryReplySource: function(chatId, displayName) {
      var store = AppCore.getStore();
      var proj = store.projects.filter(function(p) {
        return p.chats.some(function(c) { return c.id === chatId; });
      })[0];
      if (proj) store.activeProject = proj.id;
      store.activeChat = chatId;
      UIModule.closeAllPanels();
      UIModule.navigate('chat');
      var chatMod = AppCore.getModule('chat');
      if (chatMod) chatMod.renderChat();
      UIModule.toast('已切换');
    },

    // ── Calendar ──

    /** Open the calendar overlay */
    openCalendar: function() {
      var store = AppCore.getStore();
      store.calendarYear = new Date().getFullYear();
      store.calendarMonth = new Date().getMonth() + 1;
      DiaryModule.renderCalendar();
      AppCore.$('calendarOverlay').classList.add('show');
    },

    /** Close the calendar overlay */
    closeCalendar: function() {
      AppCore.$('calendarOverlay').classList.remove('show');
    },

    /** Render the calendar grid */
    renderCalendar: function() {
      var store = AppCore.getStore();
      var y = store.calendarYear;
      var m = store.calendarMonth;
      var dayHeaders = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(d) {
        return '<div class="calendar-day-header">' + d + '</div>';
      }).join('');
      AppCore.$('calendarBox').innerHTML = '<div class="calendar-header"><button class="calendar-nav" data-action="navCalendar" data-args="-1">←</button><span class="calendar-month">' + MONTHS[m-1] + ' ' + y + '</span><button class="calendar-nav" data-action="navCalendar" data-args="1">→</button></div><div class="calendar-grid">' + dayHeaders + DiaryModule.genCalendarDays(y, m) + '</div>';
    },

    /** Navigate calendar by direction */
    navCalendar: function(dir) {
      var store = AppCore.getStore();
      store.calendarMonth += (typeof dir === 'number' ? dir : parseInt(dir) || 0);
      if (store.calendarMonth > 12) { store.calendarMonth = 1; store.calendarYear++; }
      else if (store.calendarMonth < 1) { store.calendarMonth = 12; store.calendarYear--; }
      DiaryModule.renderCalendar();
    },

    /** Generate calendar day cells */
    genCalendarDays: function(y, m) {
      var store = AppCore.getStore();
      var firstDay = new Date(y, m-1, 1).getDay();
      var daysInMonth = new Date(y, m, 0).getDate();
      var today = new Date();
      var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      var entryDates = new Set(store.diaries.map(function(d) { return d.date; }));
      var html = '';
      for (var i = 0; i < firstDay; i++) html += '<div class="calendar-day other-month"></div>';
      for (var d = 1; d <= daysInMonth; d++) {
        var ds = y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        var isToday = ds === todayStr;
        var hasEntry = entryDates.has(ds);
        html += '<div class="calendar-day' + (isToday ? ' today' : '') + (hasEntry ? ' has-entry' : '') + '" data-action="goToDiaryDate" data-args="' + ds + '">' + d + '</div>';
      }
      return html;
    },

    /** Go to a specific diary date */
    goToDiaryDate: function(ds) {
      var store = AppCore.getStore();
      DiaryModule.closeCalendar();
      store.diarySelectedDate = ds;
      DiaryModule.render();
      setTimeout(function() { var el = AppCore.$('diaryScroll'); if (el) el.scrollTop = 0; }, 100);
    },

  };
})();

AppCore.register('diary', DiaryModule);
