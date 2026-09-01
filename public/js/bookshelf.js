/**
 * WarmBuddy Bookshelf Module
 * ── Bookshelf: book tracking, highlights, reading notes, AI analysis ──
 */

var BookshelfModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════

  var COVERS = ['📖','📕','📗','📘','📙','📓','📔','📒'];

  function randomCover() {
    return COVERS[Math.floor(Math.random() * COVERS.length)];
  }

  // ═══════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════

  function renderReadingNote() {
    var el = AppCore.$('readingNoteCard');
    var store = AppCore.getStore();
    var latest = null, latestBook = null;
    for (var i = 0; i < store.books.length; i++) {
      var b = store.books[i];
      for (var j = 0; j < b.highlights.length; j++) {
        var h = b.highlights[j];
        if (!latest || h.id > latest.id) {
          latest = h;
          latestBook = b;
        }
      }
    }
    if (!latest) {
      el.innerHTML = '<div class="reading-note-card"><div class="empty-state" style="padding:8px;">no reading notes yet.</div></div>';
      return;
    }
    el.innerHTML = '<div class="reading-note-card" data-action="openBookDetail" data-args="' + latestBook.id + '">' +
      '<div class="reading-note-label">latest bookmark</div>' +
      '<div class="reading-note-book">' + latestBook.cover + ' ' + AppCore.escapeHtml(latestBook.title) + ' — ' + AppCore.escapeHtml(latestBook.author) + '</div>' +
      '<div class="reading-note-text">"' + AppCore.escapeHtml(latest.text) + '"</div>' +
      (latest.note ? '<div style="font-size:13px;color:var(--text-light);margin-top:6px;">' + AppCore.escapeHtml(latest.note) + '</div>' : '') +
      '<div class="reading-note-meta">highlighted</div></div>';
  }

  function renderBookGrid() {
    var el = AppCore.$('bookshelfGrid');
    var store = AppCore.getStore();
    if (store.books.length === 0) {
      el.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">your shelf is empty.</div>';
      return;
    }
    el.innerHTML = store.books.map(function(b) {
      return '<div class="book-card" data-action="openBookDetail" data-args="' + b.id + '">' +
        '<div class="book-cover">' + b.cover + '</div>' +
        '<div class="book-title">' + AppCore.escapeHtml(b.title) + '</div>' +
        '<div class="book-author">' + AppCore.escapeHtml(b.author) + '</div>' +
        '<div class="book-progress"><div class="book-progress-bar" style="width:' + b.progress + '%"></div></div>' +
        '<div style="font-family:var(--font-en);font-size:10px;color:var(--text-lighter);margin-top:4px;">' + b.progress + '%</div></div>';
    }).join('');
  }

  function render() {
    renderReadingNote();
    renderBookGrid();
  }

  // ═══════════════════════════════════════════
  //  Add / Save book
  // ═══════════════════════════════════════════

  function showAddMenu() {
    UIModule.showModal('Add Book',
      '<button class="import-btn" data-action="triggerFileImport">📂 Import EPUB / TXT</button>' +
      '<div style="text-align:center;padding:8px;font-family:var(--font-en);font-size:11px;color:var(--text-lighter);">or</div>' +
      '<input class="modal-input" id="newBookTitle" placeholder="Book title">' +
      '<input class="modal-input" id="newBookAuthor" placeholder="Author">' +
      '<input class="modal-input" id="newBookProgress" placeholder="Progress (%)" value="0" type="number" min="0" max="100">',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'add', cls: 'confirm', onclick: saveBook }
      ]
    );
  }

  function saveBook() {
    var store = AppCore.getStore();
    var title = AppCore.$('newBookTitle').value.trim();
    var author = AppCore.$('newBookAuthor').value.trim();
    var pct = parseInt(AppCore.$('newBookProgress').value) || 0;
    if (!title) { UIModule.toast('Please enter a title'); return; }
    store.books.unshift({
      id: 'b' + AppCore.gid(''),
      title: title,
      author: author,
      cover: randomCover(),
      progress: pct,
      fileType: null,
      highlights: []
    });
    store._importing = true;
    UIModule.closeModal();
    render();
    UIModule.toast('Book added');
  }

  // ═══════════════════════════════════════════
  //  File import
  // ═══════════════════════════════════════════

  function triggerFileImport() {
    var store = AppCore.getStore();
    store._importing = true;
    UIModule.closeModal();
    AppCore.$('fileInput').click();
  }

  function handleFileImport(event) {
    var file = event.target.files[0];
    if (!file) return;
    var ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'epub' && ext !== 'txt') {
      UIModule.toast('仅支持 EPUB 和 TXT');
      event.target.value = '';
      return;
    }
    var title = file.name.replace(/\.(epub|txt)$/i, '');
    var store = AppCore.getStore();
    if (ext === 'txt') {
      var reader = new FileReader();
      reader.onload = function(e) {
        var fl = (e.target.result + '').split('\n')[0];
        fl = fl ? fl.trim().slice(0, 60) : '';
        store.books.unshift({
          id: 'b' + AppCore.gid(''),
          title: title || fl,
          author: '(imported)',
          cover: '📄',
          progress: 0,
          fileType: 'txt',
          highlights: []
        });
        render();
        UIModule.toast('TXT imported');
      };
      reader.readAsText(file);
    } else {
      store.books.unshift({
        id: 'b' + AppCore.gid(''),
        title: title,
        author: '(imported EPUB)',
        cover: '📗',
        progress: 0,
        fileType: 'epub',
        highlights: []
      });
      render();
      UIModule.toast('EPUB imported');
    }
    event.target.value = '';
  }

  // ═══════════════════════════════════════════
  //  Book detail
  // ═══════════════════════════════════════════

  function openBook(bid) {
    var store = AppCore.getStore();
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;

    var titleEscaped = AppCore.escapeHtml(book.title);
    var authorEscaped = AppCore.escapeHtml(book.author);
    var fileTypeStr = book.fileType ? '(' + book.fileType.toUpperCase() + ')' : '';

    var headerHtml = '<div class="book-detail-header">' +
      '<div class="book-detail-info">' +
      '<h3>' + book.cover + ' ' + titleEscaped + '</h3>' +
      '<div class="book-author">' + authorEscaped + ' ' + fileTypeStr + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
      '<button style="background:none;border:none;font-size:16px;color:var(--text-lighter);cursor:pointer;padding:4px;" data-action="deleteBook" data-args="' + book.id + '" title="删除此书">🗑</button>' +
      '<button style="background:none;border:none;font-size:20px;color:var(--text-lighter);cursor:pointer;padding:4px;" data-action="closeBookDetail">✕</button>' +
      '</div></div>';

    var progressHtml = '<div class="book-detail-progress"><div class="book-detail-progress-bar" style="width:' + book.progress + '%"></div></div>' +
      '<div style="font-family:var(--font-en);font-size:11px;color:var(--text-lighter);margin-bottom:16px;">reading: ' + book.progress + '%</div>';

    var addBtnHtml = '<button style="width:100%;padding:10px;border-radius:20px;border:1px dashed var(--border);background:transparent;font-family:var(--font-en);font-size:12px;color:var(--text-lighter);cursor:pointer;margin-bottom:16px;" data-action="addHighlight" data-args="' + book.id + '">+ add highlight &amp; note</button>';

    var highlightsHtml = '<div style="font-family:var(--font-en);font-size:10px;color:var(--text-lighter);letter-spacing:0.08em;margin-bottom:8px;">HIGHLIGHTS</div>';

    if (book.highlights.length === 0) {
      highlightsHtml += '<div class="empty-state" style="padding:8px;">no highlights yet.</div>';
    } else {
      highlightsHtml += book.highlights.map(function(h) {
        var itemHtml = '<div class="highlight-item">' +
          '<div class="highlight-text">"' + AppCore.escapeHtml(h.text) + '"</div>' +
          (h.note ? '<div class="highlight-note">📝 ' + AppCore.escapeHtml(h.note) + '</div>' : '') +
          '<div class="highlight-actions">' +
          '<button class="highlight-btn" data-action="askAIAboutNote" data-args="' + book.id + '|' + h.id + '">💬 ask ai</button>' +
          '</div>';
        if (h.aiResponses) {
          for (var i = 0; i < h.aiResponses.length; i++) {
            var r = h.aiResponses[i];
            itemHtml += '<div class="note-ai-response">' +
              '<div>' + AppCore.escapeHtml(r.text) + '</div>' +
              '<div class="note-ai-source" data-action="navToChatSource" data-args="' + r.chatId + '|' + encodeURIComponent(r.projectName) + '">— from ' + AppCore.escapeHtml(r.projectName) + ' / ' + AppCore.escapeHtml(r.chatName) + ' →</div>' +
              '</div>';
          }
        }
        itemHtml += '</div>';
        return itemHtml;
      }).join('');
    }

    AppCore.$('bookDetailPanel').innerHTML = headerHtml + progressHtml + addBtnHtml + highlightsHtml;
    AppCore.$('bookDetailOverlay').classList.add('show');
  }

  function closeDetail(event) {
    var overlay = AppCore.$('bookDetailOverlay');
    // If called from click event on overlay, only close if target is the overlay itself
    if (event && event.target !== overlay) return;
    overlay.classList.remove('show');
  }

  // ═══════════════════════════════════════════
  //  Delete book
  // ═══════════════════════════════════════════

  function deleteBook(bid) {
    var store = AppCore.getStore();
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    var title = book.title;
    UIModule.showModal('删除书籍',
      '<p style="font-size:14px;color:var(--text);line-height:1.6;">确定要删除 <b>"' + AppCore.escapeHtml(title) + '"</b> 吗？</p>' +
      '<p style="font-size:12px;color:var(--danger);margin-top:8px;">所有划线和高亮笔记将被永久删除。</p>' +
      '<input type="hidden" id="deleteBookBid" value="' + bid + '">',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'delete', cls: 'confirm', onclick: confirmDeleteBook }
      ]
    );
  }

  function confirmDeleteBook() {
    var store = AppCore.getStore();
    var bid = AppCore.$('deleteBookBid').value;
    store.books = store.books.filter(function(b) { return b.id !== bid; });
    store._importing = true;
    UIModule.closeModal();
    closeDetail();
    render();
    UIModule.toast('书籍已删除');
  }

  // ═══════════════════════════════════════════
  //  Highlights
  // ═══════════════════════════════════════════

  function addHighlight(bid) {
    var store = AppCore.getStore();
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    UIModule.showModal('Add Highlight',
      '<textarea class="modal-input modal-textarea" id="highlightTextInput" placeholder="划线文本..."></textarea>' +
      '<textarea class="modal-input modal-textarea" id="highlightNoteInput" placeholder="笔记（可选）..."></textarea>' +
      '<input type="hidden" id="highlightBookId" value="' + bid + '">',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'save', cls: 'confirm', onclick: saveHighlight }
      ]
    );
  }

  function saveHighlight() {
    var store = AppCore.getStore();
    var bid = AppCore.$('highlightBookId').value;
    var text = AppCore.$('highlightTextInput').value.trim();
    var note = AppCore.$('highlightNoteInput').value.trim();
    if (!text) { UIModule.toast('请输入划线文本'); return; }
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    book.highlights.unshift({
      id: 'h' + AppCore.gid(''),
      text: text,
      note: note,
      aiResponses: []
    });
    store._importing = true;
    UIModule.closeModal();
    openBook(bid);
    renderReadingNote();
    UIModule.toast('Highlight saved');
  }

  // ═══════════════════════════════════════════
  //  Ask AI about a note
  // ═══════════════════════════════════════════

  function askAI(bid, nid) {
    var store = AppCore.getStore();
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    var hl = book.highlights.find(function(h) { return h.id === nid; });
    if (!hl) return;

    var allChats = [];
    store.projects.forEach(function(p) {
      p.chats.forEach(function(c) {
        allChats.push({
          chatId: c.id,
          chatName: c.name,
          projectId: p.id,
          projectName: p.name
        });
      });
    });
    var activeCid = store.activeChat;

    var hlPreview = hl.text.slice(0, 40) + (hl.text.length > 40 ? '…' : '');

    var chatItemsHtml = allChats.map(function(ch) {
      var checkedClass = ch.chatId === activeCid ? ' checked' : '';
      return '<div class="chat-select-item" onclick="this.querySelector(\'.chat-select-check\').classList.toggle(\'checked\')">' +
        '<div class="chat-select-check' + checkedClass + '" id="chatSel_' + ch.chatId + '"></div>' +
        '<span class="chat-select-name">' + AppCore.escapeHtml(ch.chatName) + '</span>' +
        '<span class="chat-select-project">' + AppCore.escapeHtml(ch.projectName) + '</span>' +
        '</div>';
    }).join('');

    UIModule.showModal('Ask AI',
      '<p style="font-size:12px;color:var(--text-lighter);margin-bottom:8px;">"' + AppCore.escapeHtml(hlPreview) + '"</p>' +
      '<div style="max-height:200px;overflow-y:auto;margin-bottom:10px;">' + chatItemsHtml + '</div>' +
      '<input type="hidden" id="askAIBId" value="' + bid + '">' +
      '<input type="hidden" id="askAINId" value="' + nid + '">',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'ask', cls: 'confirm', onclick: doSubmitAskAI }
      ]
    );
  }

  async function doSubmitAskAI() {
    var store = AppCore.getStore();
    var bid = AppCore.$('askAIBId').value;
    var nid = AppCore.$('askAINId').value;
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    var hl = book.highlights.find(function(h) { return h.id === nid; });
    if (!hl) return;

    var selected = [];
    store.projects.forEach(function(p) {
      p.chats.forEach(function(c) {
        var el = document.getElementById('chatSel_' + c.chatId);
        if (el && el.classList.contains('checked')) {
          selected.push({ chatId: c.id, chatName: c.name, projectName: p.name });
        }
      });
    });
    if (selected.length === 0) { UIModule.toast('请至少选择一个聊天窗口'); return; }

    store._importing = true;
    UIModule.closeModal();

    if (!hl.aiResponses) hl.aiResponses = [];

    var cfg = AppCore.getActiveApiConfig();
    if (!cfg.apiKey) { UIModule.toast('请先配置 API Key'); openBook(bid); return; }

    var prompt = '关于书籍《' + book.title + '》中的这段话："' + hl.text + '"' +
      (hl.note ? '，我的笔记是：' + hl.note : '') +
      '。请用中文简短点评这段话（2-3句话），可以从文学角度、情感角度或叙事角度分析。';

    try {
      var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: cfg.apiKey,
          endpoint: cfg.endpoint,
          model: cfg.model,
          projectId: store.activeProject,
          tokenContext: { actionType: 'bookshelf', skipPersistence: true },
          messages: [{ role: 'user', content: prompt }]
        })
      });
      var data = await response.json();
      var aiText = (data.reply && data.reply.content) ? data.reply.content : '这个段落值得反复品味。';
      selected.forEach(function(ch) {
        hl.aiResponses.push({
          chatId: ch.chatId,
          chatName: ch.chatName,
          projectName: ch.projectName,
          text: aiText
        });
      });
      openBook(bid);
      UIModule.toast('AI 已回复');
    } catch (err) {
      console.error('Ask AI error:', err);
      UIModule.toast('AI 请求失败: ' + err.message);
      openBook(bid);
    }
  }

  // Legacy submitAskAI kept as internal function (used by older entry points)
  async function submitAskAI() {
    var store = AppCore.getStore();
    var bid = AppCore.$('askAIBId').value;
    var nid = AppCore.$('askAINId').value;
    var book = store.books.find(function(b) { return b.id === bid; });
    if (!book) return;
    var hl = book.highlights.find(function(h) { return h.id === nid; });
    if (!hl) return;

    var selected = [];
    store.projects.forEach(function(p) {
      p.chats.forEach(function(c) {
        var el = document.getElementById('chatSel_' + c.chatId);
        if (el && el.classList.contains('checked')) {
          selected.push({ chatId: c.id, chatName: c.name, projectName: p.name });
        }
      });
    });
    if (selected.length === 0) { UIModule.toast('请选择至少一个聊天窗口'); return; }

    store._importing = true;
    UIModule.closeModal();

    var cfg = AppCore.getActiveApiConfig();
    if (!cfg.apiKey) { UIModule.toast('请先配置 API Key'); return; }

    var prompt = '关于书籍《' + book.title + '》中的这段话："' + hl.text + '"' +
      (hl.note ? '，我的笔记是：' + hl.note : '') +
      '。请用中文简短点评这段话（2-3句话），可以从文学角度、情感角度或叙事角度分析。';

    try {
      var response = await fetch(AppCore.BACKEND_URL + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: cfg.apiKey,
          endpoint: cfg.endpoint,
          model: cfg.model,
          projectId: store.activeProject,
          tokenContext: { actionType: 'bookshelf', skipPersistence: true },
          messages: [{ role: 'user', content: prompt }]
        })
      });
      var data = await response.json();
      var aiText = (data.reply && data.reply.content) ? data.reply.content : '这个段落值得反复品味。';

      if (!hl.aiResponses) hl.aiResponses = [];
      selected.forEach(function(ch) {
        hl.aiResponses.push({
          chatId: ch.chatId,
          chatName: ch.chatName,
          projectName: ch.projectName,
          text: aiText
        });
      });
      openBook(bid);
      UIModule.toast('AI 已回复');
    } catch (err) {
      console.error('Ask AI error:', err);
      UIModule.toast('AI 请求失败: ' + err.message);
      openBook(bid);
    }
  }

  // ═══════════════════════════════════════════
  //  Navigation
  // ═══════════════════════════════════════════

  function navToChatSource(cid, pn) {
    var store = AppCore.getStore();
    var proj = store.projects.find(function(p) { return p.name === pn; });
    if (proj) store.activeProject = proj.id;
    store.activeChat = cid;
    closeDetail();
    UIModule.closeAllPanels();
    UIModule.navigate('chat');
    var chatMod = AppCore.getModule('chat');
    if (chatMod) chatMod.renderChat();
    UIModule.toast('已切换');
  }

  // ═══════════════════════════════════════════
  //  Init — event delegation for bookshelf actions
  // ═══════════════════════════════════════════
  //
  //  UIModule already has a document click handler (bubble phase) that
  //  dispatches data-action via a switch.  For actions in its switch
  //  (openBookDetail, addHighlight, showBookshelfAddMenu) it calls the
  //  matching global function if one exists; for everything else it falls
  //  through to window[action]() with no arguments.  Once the old global
  //  function definitions in index.html are removed, UIModule's dispatch
  //  becomes a no-op for these actions.
  //
  //  We register a *single* bubble-phase listener for all bookshelf
  //  actions.  Because it runs after UIModule's handler, and because
  //  UIModule does not call preventDefault / stopPropagation, both
  //  listeners fire.  When the old globals are gone there is no double-
  //  handling — UIModule's checks fail silently and only our handler
  //  does the work.

  function init() {
    document.addEventListener('click', function(event) {
      var target = event.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      var args = target.getAttribute('data-args') || '';

      switch (action) {
        // ── Actions also in UIModule's switch ──
        case 'openBookDetail':
          BookshelfModule.openBook(args);
          break;
        case 'addHighlight':
          BookshelfModule.addHighlight(args);
          break;
        case 'showBookshelfAddMenu':
          BookshelfModule.showAddMenu();
          break;

        // ── Actions NOT in UIModule's switch ──
        case 'deleteBook':
          BookshelfModule.deleteBook(args);
          break;
        case 'confirmDeleteBook':
          BookshelfModule.confirmDeleteBook();
          break;
        case 'closeBookDetail':
          BookshelfModule.closeDetail();
          break;
        case 'askAIAboutNote':
          var askParts = args.split('|');
          BookshelfModule.askAI(askParts[0], askParts[1]);
          break;
        case 'navToChatSource':
          var navParts = args.split('|');
          BookshelfModule.navToChatSource(navParts[0], decodeURIComponent(navParts[1] || ''));
          break;
        case 'triggerFileImport':
          BookshelfModule.triggerFileImport();
          break;
      }
    });

    console.log('[BookshelfModule] ✅ initialized (with event delegation)');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,

    // Render
    render: render,
    renderReadingNote: renderReadingNote,
    renderBookGrid: renderBookGrid,

    // Add / Save
    showAddMenu: showAddMenu,
    saveBook: saveBook,

    // File import
    triggerFileImport: triggerFileImport,
    handleFileImport: handleFileImport,

    // Book detail
    openBook: openBook,
    closeDetail: closeDetail,

    // Delete
    deleteBook: deleteBook,
    confirmDeleteBook: confirmDeleteBook,

    // Highlights
    addHighlight: addHighlight,
    saveHighlight: saveHighlight,

    // AI
    askAI: askAI,
    doSubmitAskAI: doSubmitAskAI,
    submitAskAI: submitAskAI,

    // Navigation
    navToChatSource: navToChatSource
  };
})();

// Register with AppCore
AppCore.register('bookshelf', BookshelfModule);
