/**
 * WarmBuddy UIModule v1.0
 * ── Page navigation, side panels, modals, toast, and theme management ──
 */

var UIModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Theme definitions
  // ═══════════════════════════════════════════
  var THEMES = {
    warmSand: { name:'暖沙',
      light:{'--bg':'#F5F0EB','--bg-card':'#FBF9F7','--bg-card-hover':'#F7F3EF','--text':'#4A4543','--text-light':'#8C8580','--text-lighter':'#B5AEAA','--accent':'#B8A99A','--accent-soft':'#D4C9BF','--accent-pale':'#E8E0D8','--border':'#E5DFD8','--border-light':'#F0EBE5','--danger':'#C4877B','--danger-light':'#F5E8E5','--shadow':'0 1px 3px rgba(74,69,67,0.04)','--shadow-md':'0 2px 8px rgba(74,69,67,0.06)','--star':'#F5A623','--text-on-accent':'#ffffff','--user-bubble-bg':'#E8E0D8','--ai-bubble-bg':'#FBF9F7'},
      dark:{'--bg':'#2C2826','--bg-card':'#383432','--bg-card-hover':'#3E3A38','--text':'#E5DFD8','--text-light':'#B5AEAA','--text-lighter':'#8C8580','--accent':'#A09080','--accent-soft':'#786860','--accent-pale':'#4A4038','--border':'#4A4543','--border-light':'#3E3A38','--danger':'#C4877B','--danger-light':'#3A2826','--shadow':'0 1px 3px rgba(0,0,0,0.2)','--shadow-md':'0 2px 8px rgba(0,0,0,0.3)','--star':'#F5A623','--text-on-accent':'#ffffff','--user-bubble-bg':'#4A4038','--ai-bubble-bg':'#383432'}
    },
    matcha: { name:'抹茶',
      light:{'--bg':'#EDEEE8','--bg-card':'#F5F5F0','--bg-card-hover':'#EEEEE8','--text':'#2E3328','--text-light':'#65734F','--text-lighter':'#A68C76','--accent':'#455952','--accent-soft':'#65734F','--accent-pale':'#D9D2D0','--border':'#D0CECA','--border-light':'#E2E0DC','--danger':'#A66832','--danger-light':'#F0E8DC','--shadow':'0 1px 3px rgba(69,89,82,0.05)','--shadow-md':'0 2px 8px rgba(69,89,82,0.08)','--star':'#A66832','--text-on-accent':'#F5F5F0','--user-bubble-bg':'#D9D2D0','--ai-bubble-bg':'#F5F5F0'},
      dark:{'--bg':'#1E2420','--bg-card':'#272E28','--bg-card-hover':'#2D3530','--text':'#D9D2D0','--text-light':'#A68C76','--text-lighter':'#65734F','--accent':'#7A9B8A','--accent-soft':'#556650','--accent-pale':'#2D3530','--border':'#384038','--border-light':'#2D3530','--danger':'#A66832','--danger-light':'#2E2418','--shadow':'0 1px 3px rgba(0,0,0,0.25)','--shadow-md':'0 2px 8px rgba(0,0,0,0.35)','--star':'#C4883A','--text-on-accent':'#F5F5F0','--user-bubble-bg':'#2D3530','--ai-bubble-bg':'#272E28'}
    },
    snowPeak: { name:'雪顶',
      light:{'--bg':'#EEF0F3','--bg-card':'#F6F7F9','--bg-card-hover':'#ECEEF2','--text':'#0D2235','--text-light':'#4D6173','--text-lighter':'#93ABBF','--accent':'#4D6173','--accent-soft':'#93ABBF','--accent-pale':'#D0D3D9','--border':'#CDD0D6','--border-light':'#DDE0E5','--danger':'#8A5A5A','--danger-light':'#F0E8E8','--shadow':'0 1px 3px rgba(9,38,64,0.05)','--shadow-md':'0 2px 8px rgba(9,38,64,0.08)','--star':'#BF9A60','--text-on-accent':'#F6F7F9','--user-bubble-bg':'#D0D3D9','--ai-bubble-bg':'#F6F7F9'},
      dark:{'--bg':'#0A1929','--bg-card':'#112236','--bg-card-hover':'#162C42','--text':'#D0D3D9','--text-light':'#93ABBF','--text-lighter':'#4D6173','--accent':'#93ABBF','--accent-soft':'#4D6173','--accent-pale':'#162C42','--border':'#253A50','--border-light':'#1A2F44','--danger':'#9A6060','--danger-light':'#1E1010','--shadow':'0 1px 3px rgba(0,0,0,0.3)','--shadow-md':'0 2px 8px rgba(0,0,0,0.4)','--star':'#BF9A60','--text-on-accent':'#F6F7F9','--user-bubble-bg':'#162C42','--ai-bubble-bg':'#112236'}
    },
    strawberry: { name:'草莓',
      light:{'--bg':'#FAF0EC','--bg-card':'#FDF7F5','--bg-card-hover':'#F8EFE9','--text':'#3A2020','--text-light':'#8A5050','--text-lighter':'#C49090','--accent':'#984243','--accent-soft':'#D79A95','--accent-pale':'#F8D8CC','--border':'#EDD5CE','--border-light':'#F5E5E0','--danger':'#984243','--danger-light':'#FCE8E5','--shadow':'0 1px 3px rgba(152,66,67,0.05)','--shadow-md':'0 2px 8px rgba(152,66,67,0.08)','--star':'#D4763A','--text-on-accent':'#FDF7F5','--user-bubble-bg':'#F8D8CC','--ai-bubble-bg':'#FDF7F5'},
      dark:{'--bg':'#261618','--bg-card':'#32201E','--bg-card-hover':'#3A2826','--text':'#F2E4DB','--text-light':'#D79A95','--text-lighter':'#8A5050','--accent':'#D79A95','--accent-soft':'#984243','--accent-pale':'#3A2826','--border':'#52302E','--border-light':'#3A2826','--danger':'#C45858','--danger-light':'#281010','--shadow':'0 1px 3px rgba(0,0,0,0.25)','--shadow-md':'0 2px 8px rgba(0,0,0,0.35)','--star':'#D4763A','--text-on-accent':'#FDF7F5','--user-bubble-bg':'#3A2826','--ai-bubble-bg':'#32201E'}
    },
    cream: { name:'奶油',
      light:{'--bg':'#F4F3E0','--bg-card':'#FAFAEE','--bg-card-hover':'#F2F1DC','--text':'#3A3820','--text-light':'#6B6A50','--text-lighter':'#A2A697','--accent':'#79A2CE','--accent-soft':'#B2CBD2','--accent-pale':'#E0ECF0','--border':'#E0DEC6','--border-light':'#ECEADE','--danger':'#B07840','--danger-light':'#F5EAD8','--shadow':'0 1px 3px rgba(58,56,32,0.04)','--shadow-md':'0 2px 8px rgba(58,56,32,0.07)','--star':'#D4A820','--text-on-accent':'#FAFAEE','--user-bubble-bg':'#E8EBCE','--ai-bubble-bg':'#FAFAEE'},
      dark:{'--bg':'#202018','--bg-card':'#2A2A1E','--bg-card-hover':'#323224','--text':'#F0ECCC','--text-light':'#A2A697','--text-lighter':'#6B6A50','--accent':'#79A2CE','--accent-soft':'#4D7A9E','--accent-pale':'#20304A','--border':'#3A3A28','--border-light':'#2A2A1E','--danger':'#C09050','--danger-light':'#281E08','--shadow':'0 1px 3px rgba(0,0,0,0.25)','--shadow-md':'0 2px 8px rgba(0,0,0,0.35)','--star':'#D4A820','--text-on-accent':'#FAFAEE','--user-bubble-bg':'#32321E','--ai-bubble-bg':'#2A2A1E'}
    },
    library: { name:'藏书',
      light:{'--bg':'#EDE8E2','--bg-card':'#F5F2EE','--bg-card-hover':'#EAE5DE','--text':'#2E2820','--text-light':'#72715B','--text-lighter':'#BF8C80','--accent':'#705D73','--accent-soft':'#9D8EA0','--accent-pale':'#E0D8E2','--border':'#D8D0C8','--border-light':'#E8E2DA','--danger':'#A05A50','--danger-light':'#F0E5E2','--shadow':'0 1px 3px rgba(67,59,46,0.05)','--shadow-md':'0 2px 8px rgba(67,59,46,0.08)','--star':'#BF8C54','--text-on-accent':'#F5F2EE','--user-bubble-bg':'#D3BBA1','--ai-bubble-bg':'#F5F2EE'},
      dark:{'--bg':'#1E1A16','--bg-card':'#28221C','--bg-card-hover':'#322A22','--text':'#D3BBA1','--text-light':'#BF8C80','--text-lighter':'#72715B','--accent':'#9D8EA0','--accent-soft':'#705D73','--accent-pale':'#322A2E','--border':'#433B2E','--border-light':'#322A22','--danger':'#A05A50','--danger-light':'#281210','--shadow':'0 1px 3px rgba(0,0,0,0.28)','--shadow-md':'0 2px 8px rgba(0,0,0,0.38)','--star':'#BF8C54','--text-on-accent':'#F5F2EE','--user-bubble-bg':'#322A22','--ai-bubble-bg':'#28221C'}
    },
    inkPaper: { name:'墨纸',
      light:{'--bg':'#F0EDE5','--bg-card':'#F8F6F0','--bg-card-hover':'#EDE9E0','--text':'#1C1A14','--text-light':'#5C5848','--text-lighter':'#A09880','--accent':'#3A3520','--accent-soft':'#7A7260','--accent-pale':'#E4E0D4','--border':'#D8D4C8','--border-light':'#E8E4DC','--danger':'#8A4A38','--danger-light':'#F0E5DF','--shadow':'0 1px 3px rgba(28,26,20,0.05)','--shadow-md':'0 2px 8px rgba(28,26,20,0.09)','--star':'#C8A040','--text-on-accent':'#F8F6F0','--user-bubble-bg':'#E4E0D4','--ai-bubble-bg':'#F8F6F0'},
      dark:{'--bg':'#141210','--bg-card':'#1E1C18','--bg-card-hover':'#262420','--text':'#EDE8DC','--text-light':'#B0A890','--text-lighter':'#706858','--accent':'#C8A040','--accent-soft':'#8C7430','--accent-pale':'#2A2418','--border':'#302C24','--border-light':'#262420','--danger':'#A05A40','--danger-light':'#201408','--shadow':'0 1px 3px rgba(0,0,0,0.35)','--shadow-md':'0 2px 8px rgba(0,0,0,0.48)','--star':'#C8A040','--text-on-accent':'#141210','--user-bubble-bg':'#2A2418','--ai-bubble-bg':'#1E1C18'}
    }
  };

  // ═══════════════════════════════════════════
  //  Toast
  // ═══════════════════════════════════════════
  function toast(m) {
    var t = AppCore.$('toast');
    if (!t) return;
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function() { t.classList.remove('show'); }, 2000);
  }

  function showStatusToast(m) {
    var t = AppCore.$('toast');
    if (!t) return;
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(function() { t.classList.remove('show'); }, 3500);
  }

  // ═══════════════════════════════════════════
  //  Navigation
  // ═══════════════════════════════════════════
  function navigate(p) {
    document.querySelectorAll('.page').forEach(function(x) { x.classList.remove('active'); });
    var t = AppCore.$('page-' + p);
    if (t) t.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(function(x) { x.classList.remove('active'); });
    var n = document.querySelector('.nav-item[data-page="' + p + '"]');
    if (n) n.classList.add('active');
    closeAllPanels();
    // Delegate to global render functions (until those modules are extracted)
    if (p === 'home') { if (typeof renderHome === 'function') renderHome(); }
    else if (p === 'chat') { if (typeof renderChat === 'function') renderChat(); }
    else if (p === 'bookshelf') { if (typeof renderBookshelf === 'function') renderBookshelf(); }
    else if (p === 'diary') { if (typeof renderDiary === 'function') renderDiary(); }
  }

  function goHome() { navigate('home'); }

  // ═══════════════════════════════════════════
  //  Side panels
  // ═══════════════════════════════════════════
  function closeAllPanels() {
    var sp = AppCore.$('settingsPanel');
    var ps = AppCore.$('projectSidebar');
    var mp = AppCore.$('memoryPanel');
    var ov = AppCore.$('overlay');
    if (sp) sp.classList.remove('open');
    if (ps) ps.classList.remove('open');
    if (mp) mp.classList.remove('open');
    if (ov) ov.classList.remove('show');
  }

  function toggleSettings() {
    var p = AppCore.$('settingsPanel');
    var o = AppCore.$('overlay');
    var is = p.classList.contains('open');
    closeAllPanels();
    if (!is) { p.classList.add('open'); o.classList.add('show'); if (typeof updateSettingsUI === 'function') updateSettingsUI(); }
  }

  function toggleProjectSidebar() {
    var p = AppCore.$('projectSidebar');
    var o = AppCore.$('overlay');
    var is = p.classList.contains('open');
    closeAllPanels();
    if (!is) { p.classList.add('open'); o.classList.add('show'); if (typeof renderProjectList === 'function') renderProjectList(); }
  }

  function openMemoryPanel(tab) {
    closeAllPanels();
    var mp = AppCore.$('memoryPanel');
    var ov = AppCore.$('overlay');
    if (mp) mp.classList.add('open');
    if (ov) ov.classList.add('show');
    if (tab === 'tokens') { if (typeof switchMemoryTab === 'function') switchMemoryTab('tokens'); }
    else { if (typeof switchMemoryTab === 'function') switchMemoryTab('memories'); }
  }

  function closeMemoryPanel() {
    var mp = AppCore.$('memoryPanel');
    var ov = AppCore.$('overlay');
    if (mp) mp.classList.remove('open');
    if (ov) ov.classList.remove('show');
  }

  // ═══════════════════════════════════════════
  //  Modal
  // ═══════════════════════════════════════════
  function showModal(title, bodyHtml, actions) {
    AppCore.$('modalTitle').innerHTML = title;
    AppCore.$('modalBody').innerHTML = bodyHtml;
    AppCore.$('modalActions')._callbacks = actions.map(function(a) { return a.onclick; });
    AppCore.$('modalActions').innerHTML = actions.map(function(a, i) {
      return '<button class="modal-btn ' + (a.cls || 'cancel') + '" data-modal-action="' + i + '">' + a.label + '</button>';
    }).join('');
    AppCore.$('modalOverlay').classList.add('show');
    if (!AppCore.$('modalActions')._listenerReady) {
      AppCore.$('modalActions')._listenerReady = true;
      AppCore.$('modalActions').addEventListener('click', function(e) {
        var btn = e.target.closest('.modal-btn');
        if (!btn || !AppCore.$('modalActions')._callbacks) return;
        var idx = parseInt(btn.getAttribute('data-modal-action'));
        var fn = AppCore.$('modalActions')._callbacks[idx];
        if (typeof fn === 'function') fn();
      });
    }
  }

  function closeModal() { AppCore.$('modalOverlay').classList.remove('show'); }

  // ═══════════════════════════════════════════
  //  Theme
  // ═══════════════════════════════════════════
  function applyTheme(themeId, darkMode) {
    var theme = THEMES[themeId];
    if (!theme) return;
    var mode = darkMode ? theme.dark : theme.light;
    var root = document.documentElement;
    Object.keys(mode).forEach(function(k) { root.style.setProperty(k, mode[k]); });
    var store = AppCore.getStore();
    store.themeId = themeId;
    store.darkMode = darkMode;
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', mode['--bg']);
    document.body.setAttribute('data-theme', themeId);
    document.body.classList.toggle('dark', darkMode);
    var dms = AppCore.$('darkModeStatus');
    if (dms) dms.textContent = darkMode ? 'on' : 'off';
    AppCore.saveStore();
  }

  function initTheme() {
    var store = AppCore.getStore();
    applyTheme(store.themeId || 'warmSand', store.darkMode || false);
  }

  function toggleDarkMode() {
    var store = AppCore.getStore();
    applyTheme(store.themeId || 'warmSand', !store.darkMode);
    if (typeof renderThemePicker === 'function') renderThemePicker();
  }

  function renderThemePicker() {
    var container = AppCore.$('theme-picker');
    if (!container) return;
    var store = AppCore.getStore();
    var themeNames = Object.keys(THEMES);
    var html = '';
    for (var i = 0; i < themeNames.length; i++) {
      var id = themeNames[i];
      var theme = THEMES[id];
      var isActive = store.themeId === id;
      var colors = store.darkMode ? theme.dark : theme.light;
      html += '<div class="theme-chip' + (isActive ? ' active' : '') + '" onclick="applyTheme(\'' + id + '\', store.darkMode); renderThemePicker();" title="' + theme.name + '">' +
        '<span class="theme-chip-dots"><span style="background:' + colors['--bg'] + '"></span><span style="background:' + colors['--accent'] + '"></span><span style="background:' + colors['--user-bubble-bg'] + '"></span></span>' +
        '<span class="theme-chip-name">' + theme.name + '</span>' +
        (isActive ? '<span class="theme-chip-check">✓</span>' : '') +
      '</div>';
    }
    container.innerHTML = html;
  }

  // ═══════════════════════════════════════════
  //  Init — bind event delegation + global click handler
  // ═══════════════════════════════════════════
  function init() {
    document.addEventListener('click', function(event) {
      var target = event.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      var args = target.getAttribute('data-args') || '';

      switch (action) {
        // Navigation
        case 'navigate': navigate(args); break;
        case 'goHome': goHome(); break;
        // Panels
        case 'closeAllPanels': closeAllPanels(); break;
        case 'toggleSettings': toggleSettings(); break;
        case 'toggleProjectSidebar': toggleProjectSidebar(); break;
        case 'openMemoryPanel': var tab = args || undefined; openMemoryPanel(tab); break;
        case 'closeMemoryPanel': closeMemoryPanel(); break;
        // Modal
        case 'closeModal': closeModal(); break;
        case 'modalClick': break; // No-op: prevent click inside container from bubbling to overlay
        case 'panelClick': break;
        // Theme
        case 'toggleDarkMode': toggleDarkMode(); break;
        // Chat
        case 'sendMessage': var c = AppCore.getModule('chat'); if (c) c.sendMessage(); break;
        case 'cancelReply': var c2 = AppCore.getModule('chat'); if (c2) c2.cancelReply(); break;
        case 'stageDraftBubble': var c3 = AppCore.getModule('chat'); if (c3) c3.stageDraftBubble(); break;
        case 'toggleMoreMenu': var c4 = AppCore.getModule('chat'); if (c4) c4.toggleMoreMenu(); break;
        case 'exitBatchSelectMode': var c5 = AppCore.getModule('chat'); if (c5) c5.exitBatchSelectMode(); break;
        case 'confirmBatchStar': var c6 = AppCore.getModule('chat'); if (c6) c6.confirmBatchStar(); break;
        case 'openPokeSettings': var c7 = AppCore.getModule('chat'); if (c7) c7.openPokeSettings(); break;
        case 'saveDraftBubble': var c8 = AppCore.getModule('chat'); if (c8) c8.saveDraftBubble(); break;
        case 'deleteDraftBubble': var c9 = AppCore.getModule('chat'); if (c9) c9.deleteDraftBubble(); break;
        case 'closeDraftEditor': var c10 = AppCore.getModule('chat'); if (c10) c10.closeDraftEditor(); break;
        case 'handleAIAvatarDblClick': var c11 = AppCore.getModule('chat'); if (c11) c11.handleAIAvatarDblClick(); break;
        case 'sendAllDraftBubbles': var c12 = AppCore.getModule('chat'); if (c12) c12.sendAllDraftBubbles(); break;
        // Project/Chat management
        case 'addProject': var c13 = AppCore.getModule('chat'); if (c13) c13.addProject(); break;
        // Todo
        case 'addTodo': var t = AppCore.getModule('todo'); if (t) t.addTodo(); break;
        case 'switchTodoTab':
          var tabMod = AppCore.getModule('todo');
          if (tabMod) tabMod.switchTodoTab(args, target);
          break;
        // Settings
        case 'showProjectApiModal': var s = AppCore.getModule('settings'); if (s) s.showProjectApiModal(); break;
        case 'showModelModal': var s2 = AppCore.getModule('settings'); if (s2) s2.showModelModal(); break;
        case 'showPreferenceModal': var s3 = AppCore.getModule('chat'); if (s3) s3.showPreferenceModal(); break;
        case 'showAiNameModal': var s4 = AppCore.getModule('chat'); if (s4) s4.showAiNameModal(); break;
        case 'toggleAiSetting':
          var k = args;
          var set = AppCore.getModule('settings');
          if (set) set.toggleAiSetting(k);
          break;
        // Toolkit
        case 'showAddToolModal':
          var tk = AppCore.getModule('toolkit');
          if (tk) tk.showAddToolModal();
          break;
        case 'showWindowToolsModal':
          var tk2 = AppCore.getModule('toolkit');
          if (tk2) tk2.showWindowToolsModal();
          break;
        // Tool call panel
        case 'toggleToolCallPanel':
          var chatM = AppCore.getModule('chat');
          if (chatM && chatM.toggleToolCallPanel) chatM.toggleToolCallPanel(args);
          break;
        case 'showToolCallDetail':
          var chatM2 = AppCore.getModule('chat');
          if (chatM2 && chatM2.showToolCallDetail) {
            var parts = args.split('|');
            chatM2.showToolCallDetail(parts[0], parseInt(parts[1]) || 0);
          }
          break;
        // Memory panel
        case 'switchMemoryTab': if (typeof switchMemoryTab === 'function') switchMemoryTab(args); break;
        case 'showCoreHistory':
          if (MemoryModule.showCoreHistoryModal) {
            MemoryModule.showCoreHistoryModal(AppCore.getStore().activeProject);
          }
          break;
        case 'openMemoryPanelTokens': openMemoryPanel('tokens'); break;
        // Diary
        case 'addDiaryEntry':
          var diaryMod = AppCore.getModule('diary');
          if (diaryMod && diaryMod.addEntry) diaryMod.addEntry();
          break;
        case 'addDiaryReply':
          var diaryMod2 = AppCore.getModule('diary');
          if (diaryMod2 && diaryMod2.addReply) diaryMod2.addReply(args);
          break;
        case 'editDiaryEntry':
          var diaryMod3 = AppCore.getModule('diary');
          if (diaryMod3 && diaryMod3.editEntry) diaryMod3.editEntry(args);
          break;
        case 'toggleReplyAuthor':
          var diaryMod4 = AppCore.getModule('diary');
          if (diaryMod4 && diaryMod4.toggleReplyAuthor) diaryMod4.toggleReplyAuthor();
          break;
        case 'selectMoodInModal':
          var diaryMod5 = AppCore.getModule('diary');
          if (diaryMod5 && diaryMod5.selectMood) diaryMod5.selectMood(args);
          break;
        case 'navigateToDiaryReplySource':
          var diaryMod6 = AppCore.getModule('diary');
          if (diaryMod6 && diaryMod6.navigateToDiaryReplySource) diaryMod6.navigateToDiaryReplySource(args);
          break;
        case 'openCalendar':
          var diaryMod7 = AppCore.getModule('diary');
          if (diaryMod7 && diaryMod7.openCalendar) diaryMod7.openCalendar();
          break;
        case 'closeCalendar':
          var diaryMod8 = AppCore.getModule('diary');
          if (diaryMod8 && diaryMod8.closeCalendar) diaryMod8.closeCalendar();
          break;
        case 'navCalendar':
          var diaryMod9 = AppCore.getModule('diary');
          if (diaryMod9 && diaryMod9.navCalendar) diaryMod9.navCalendar(args);
          break;
        case 'goToDiaryDate':
          var diaryMod10 = AppCore.getModule('diary');
          if (diaryMod10 && diaryMod10.goToDiaryDate) diaryMod10.goToDiaryDate(args);
          break;
        // Artifacts
        case 'closeArtifactViewer': var artM = AppCore.getModule('artifacts'); if (artM && artM.closeViewer) artM.closeViewer(); break;
        case 'downloadArtifact': var artM2 = AppCore.getModule('artifacts'); if (artM2 && artM2.download) artM2.download(); break;
        case 'openArtifactNewTab': var artM3 = AppCore.getModule('artifacts'); if (artM3 && artM3.openNewTab) artM3.openNewTab(); break;
        case 'deleteArtifact': var artM4 = AppCore.getModule('artifacts'); if (artM4 && artM4.deleteArtifact) artM4.deleteArtifact(args); break;
        // Data / Backup
        case 'exportAllData': var buM = AppCore.getModule('backup'); if (buM && buM.exportData) buM.exportData(); break;
        case 'importAllData': var buM2 = AppCore.getModule('backup'); if (buM2 && buM2.importData) buM2.importData(); break;
        case 'clearAllData': var buM3 = AppCore.getModule('backup'); if (buM3 && buM3.clearAll) buM3.clearAll(); break;
        // Email
        case 'showEmailConfigModal': var emM = AppCore.getModule('email'); if (emM && emM.showConfig) emM.showConfig(); break;
        case 'toggleEmailEnabled': var emM2 = AppCore.getModule('email'); if (emM2 && emM2.toggleEnabled) emM2.toggleEnabled(); break;
        // Litter box
        case 'shakeLitterBox':
          var lbMod = AppCore.getModule('litterbox');
          if (lbMod && lbMod.shake) lbMod.shake();
          break;
        case 'dismissLitterThought':
          var lbMod2 = AppCore.getModule('litterbox');
          if (lbMod2 && lbMod2.dismiss) lbMod2.dismiss(args);
          break;
        // Bookshelf
        case 'openBookDetail': var bsM = AppCore.getModule('bookshelf'); if (bsM && bsM.openBook) bsM.openBook(args); break;
        case 'deleteBook': var bsM2 = AppCore.getModule('bookshelf'); if (bsM2 && bsM2.deleteBook) { var parts = args.split('|'); bsM2.deleteBook(parts[0], parts[1]); } break;
        case 'closeBookDetail': var bsM3 = AppCore.getModule('bookshelf'); if (bsM3 && bsM3.closeDetail) bsM3.closeDetail(); break;
        case 'addHighlight': var bsM4 = AppCore.getModule('bookshelf'); if (bsM4 && bsM4.addHighlight) bsM4.addHighlight(args); break;
        case 'askAIAboutNote': var bsM5 = AppCore.getModule('bookshelf'); if (bsM5 && bsM5.askAI) { var p2 = args.split('|'); bsM5.askAI(p2[0], p2[1]); } break;
        case 'navToChatSource': var bsM6 = AppCore.getModule('bookshelf'); if (bsM6 && bsM6.navToChatSource) { var p3 = args.split('|'); bsM6.navToChatSource(p3[0], p3[1]); } break;
        case 'showBookshelfAddMenu': var bsM7 = AppCore.getModule('bookshelf'); if (bsM7 && bsM7.showAddMenu) bsM7.showAddMenu(); break;
        // Fallback: try calling as global function
        default:
          var fn = window[action];
          if (typeof fn === 'function') fn();
      }
    });
    console.log('[UIModule] ✅ initialized (with event delegation)');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════
  return {
    init: init,

    // Navigation
    navigate: navigate,
    goHome: goHome,

    // Panels
    closeAllPanels: closeAllPanels,
    toggleSettings: toggleSettings,
    toggleProjectSidebar: toggleProjectSidebar,
    openMemoryPanel: openMemoryPanel,
    closeMemoryPanel: closeMemoryPanel,

    // Modal
    showModal: showModal,
    closeModal: closeModal,

    // Toast
    toast: toast,
    showStatusToast: showStatusToast,

    // Theme
    THEMES: THEMES,
    applyTheme: applyTheme,
    initTheme: initTheme,
    toggleDarkMode: toggleDarkMode,
    renderThemePicker: renderThemePicker
  };
})();

// Register with AppCore
AppCore.register('ui', UIModule);
