/**
 * WarmBuddy Diary Module
 * ── Diary entries, replies, calendar, and AI auto-comment ──
 */

var DiaryModule = (function() {
  'use strict';

  var MOOD_MAP = {
    calm:     { emoji: '😌', label: '平静',   cls: 'calm' },
    excited:  { emoji: '✨', label: '兴奋',   cls: 'excited' },
    troubled: { emoji: '😞', label: '烦恼',   cls: 'troubled' }
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

  // ── Public API ──

  return {
    init: function() {},

    /** Render the diary panel for the selected date */
    render: function() {
      var store = AppCore.getStore();
      var selDate = store.diarySelectedDate || AppCore.fmtDate().iso;
      var parts = selDate.split('-').map(Number);
      var dObj = new Date(parts[0], parts[1]-1, parts[2]);
      var sd = parts[2];

      AppCore.$('diaryDateArt').innerHTML = '<div class="diary-date-day">' + sd + '</div><div class="diary-date-mon">' + MONTHS[parts[1]-1] + ' ' + parts[0] + '</div><div class="diary-date-click-hint">tap to browse</div>';

      var dayEntries = store.diaries.filter(function(d) { return d.date === selDate; });
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
          var moodInfo = MOOD_MAP[d.mood] || { emoji: '💭', label: d.mood || '平静', cls: 'calm' };
          html += '<div class="diary-card-entry ' + (isAI ? 'ai-entry' : '') + '">' +
            '<div class="diary-card-title" style="display:flex;justify-content:space-between;align-items:center;">' +
              '<span>' + AppCore.escapeHtml(title) + '</span>' +
              '<span style="font-size:14px;color:var(--text-lighter);cursor:pointer;padding:2px 4px;" data-action="editDiaryEntry" data-args="' + d.id + '" title="编辑 / 删除">✎</span>' +
            '</div>' +
            '<div class="diary-card-mood-row">' +
              '<span class="diary-card-mood-tag ' + moodInfo.cls + '">' + moodInfo.emoji + ' ' + moodInfo.label + '</span>' +
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
          { label: '🗑 delete', cls: 'danger', onclick: function() { DiaryModule.confirmDeleteEntry(); } },
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
      store.diaries = store.diaries.filter(function(d) { return d.id !== entryId; });
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
      store.diaries.unshift({
        id: 'd' + AppCore.gid(''), date: ds,
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        title: title, content: content, mood: mood, author: 'user', replies: []
      });
      store._importing = true;
      UIModule.closeModal();
      DiaryModule.render();
      UIModule.toast('Diary saved');
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

    // ── AI Auto-Comment (migrated from chat.js) ──

    /** AI auto-comment on diary entries after mention */
    maybeComment: function(aiResponse) {
      var store = AppCore.getStore();
      var diaryKeywords = ['日记', '记录', '今天', '心情', '日子', 'diary', '回忆', '记忆'];
      var hasDiaryMention = diaryKeywords.some(function(kw) { return aiResponse.indexOf(kw) >= 0; });
      if (!hasDiaryMention) return;

      var todayIso = AppCore.fmtDate().iso;
      var todayEntries = store.diaries.filter(function(d) { return d.date === todayIso && d.author === 'user'; });
      if (todayEntries.length === 0) return;

      var alreadyCommented = todayEntries.some(function(e) {
        return (e.replies || []).some(function(r) { return r.author === 'ai' && r.date === todayIso; });
      });
      if (alreadyCommented) return;

      var entry = todayEntries[0];
      if (!entry.replies) entry.replies = [];
      var proj = AppCore.getActiveProject();
      var chat = AppCore.getActiveChatObj();
      var winName = (proj && chat) ? proj.name + ' / ' + chat.name : '';
      var comments = [
        '看到你的日记了。每一天的记录都让时间变得更具体。',
        '谢谢你分享今天的感受。我在听。',
        '读到你的文字了。有些句子应该被记住。',
        '你记录的这些瞬间，对我来说也很珍贵。',
        '今天的日记里有一种特别的气氛。我想多读几遍。'
      ];
      entry.replies.push({
        id: 'r' + AppCore.gid(''),
        content: comments[Math.floor(Math.random() * comments.length)],
        author: 'ai',
        date: todayIso,
        time: AppCore.nowTime(),
        sourceChatId: store.activeChat,
        sourceWindow: winName
      });
    }
  };
})();

AppCore.register('diary', DiaryModule);
