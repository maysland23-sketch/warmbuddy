/**
 * WarmBuddy Backup Module
 * ── Data export/import (full backup + memory JSON) ──
 */

var BackupModule = (function() {
  'use strict';

  var pendingImportData = null;

  // ── Local helpers ──

  function getChatObjById(cid) {
    var store = AppCore.getStore();
    for (var pi = 0; pi < store.projects.length; pi++) {
      var p = store.projects[pi];
      for (var ci = 0; ci < p.chats.length; ci++) {
        if (p.chats[ci].id === cid) return p.chats[ci];
      }
    }
    return null;
  }

  // ── Core export/import ──

  async function exportAllData() {
    var data = {};
    var allKeys = await localforage.keys();
    for (var i = 0; i < allKeys.length; i++) {
      var key = allKeys[i];
      if (key && (key.startsWith('warmbuddy-') || key === 'userLocation')) {
        try {
          var val = await localforage.getItem(key);
          data[key] = typeof val === 'string' ? val : JSON.stringify(val);
        } catch (e) { data[key] = null; }
      }
    }
    var date = new Date().toISOString().slice(0, 10);
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'warmbuddy_backup_' + date + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    UIModule.toast('\u{1F4E5} 数据已导出，请妥善保存');
  }

  function importAllData() {
    console.log('[import] importAllData called');
    var input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = function(e) {
      var file = e.target.files[0];
      console.log('[import] file selected:', file.name, file.size);
      if (!file) { input.remove(); return; }
      var reader = new FileReader();
      reader.onload = function(ev) {
        try {
          var data = JSON.parse(ev.target.result);
          console.log('[import] JSON parsed, keys:', Object.keys(data).length);
          if (typeof data !== 'object' || !data || Array.isArray(data)) throw new Error('Invalid format');
          pendingImportData = data;
          console.log('[import] showing confirmation modal');
          UIModule.showModal('确认导入', '<p style="font-size:14px;color:var(--text);line-height:1.6;">导入将覆盖当前所有数据（含聊天、日记、设置等），确定继续？</p>', [
            { label: 'cancel', cls: 'cancel', onclick: function() { pendingImportData = null; UIModule.closeModal(); } },
            { label: '确认导入', cls: 'danger', onclick: executeImport }
          ]);
        } catch (err) {
          UIModule.toast('❌ 文件格式无效，请检查是否为 warmbuddy 备份文件');
        }
      };
      reader.readAsText(file);
      input.remove();
    };
    input.click();
  }

  async function executeImport() {
    if (!pendingImportData) return;
    console.log('[import] executeImport called');
    var store = AppCore.getStore();
    store._importLock = true;
    UIModule.closeModal();

    var allKeys = await localforage.keys();
    for (var ki = 0; ki < allKeys.length; ki++) {
      var k = allKeys[ki];
      if (k && (k.startsWith('warmbuddy-') || k === 'userLocation')) {
        await localforage.removeItem(k);
      }
    }
    for (var li = 0; li < localStorage.length; li++) {
      var lk = localStorage.key(li);
      if (lk && (lk.startsWith('warmbuddy-') || lk === 'userLocation')) {
        localStorage.removeItem(lk);
      }
    }

    var entries = Object.entries(pendingImportData);
    for (var ei = 0; ei < entries.length; ei++) {
      var key = entries[ei][0];
      var v = entries[ei][1];
      var value = (typeof v === 'string') ? JSON.parse(v) : v;
      await localforage.setItem(key, value);
    }

    pendingImportData = null;
    UIModule.toast('\u{1F4E4} 数据已导入，即将刷新…');
    location.reload();
  }

  function clearAll() {
    var store = AppCore.getStore();
    UIModule.showModal('Clear All Data',
      '<p style="font-size:14px;color:var(--text);line-height:1.6;">确定要清除所有数据吗？此操作不可撤销。</p>',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'clear all', cls: 'confirm', onclick: function() {
          store.todos = [];
          store.litterThoughts = [];
          store.books = [];
          store.diaries = [];
          store.projects = [{
            id: 'p1', name: 'default', preference: '',
            apiConfig: { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true },
            memories: [],
            chats: [{
              id: 'c1', name: 'default', sharedMemoryIds: [], weeklyExports: [],
              messages: [], chatTokens: 0, lastConversationDate: null, lastActiveDate: null, lastInteractionTime: null
            }]
          }];
          store.tokenUsage.used = 0;
          store.tokenUsage.history = [];
          store.activeProject = 'p1';
          store.activeChat = 'c1';
          AppCore.saveStore();
          store._importing = true;
          UIModule.closeModal();
          renderAll();
          UIModule.toast('All data cleared');
        }}
      ]
    );
  }

  // ── Memory JSON import ──

  function handleMemoryImport(event) {
    var file = event.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var data = JSON.parse(e.target.result);
        importMemoriesJSON(data);
      } catch (err) {
        UIModule.toast('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function importMemoriesJSON(data) {
    var store = AppCore.getStore();
    var proj = AppCore.getActiveProject();
    if (!proj) return;
    var result = MemoryModule.importJSON(proj.id, data);

    if (result.added > 0 || result.updated > 0) {
      var cml = MemoryModule.getCML(proj.id);
      if (cml) {
        if (!proj.coreMemoryLayers) proj.coreMemoryLayers = { aiEmotionalMemories: [], userStarredMemories: [], diaryAndLitterbox: [] };
        proj.coreMemoryLayers.aiEmotionalMemories = cml.aiEmotionalMemories;
        proj.coreMemoryLayers.userStarredMemories = cml.userStarredMemories;
        proj.coreMemoryLayers.diaryAndLitterbox = cml.diaryAndLitterbox;
      }
    }

    if (result.total === 0) { UIModule.toast('No valid memories found in file'); return; }
    if (result.added === 0 && result.updated === 0) { UIModule.toast('No new memories to import (all duplicates)'); return; }
    UIModule.toast('已导入：新增 ' + result.added + '条、更新 ' + result.updated + '条、跳过 ' + result.skipped + '条');
    AppCore.saveStore();
    renderMemoryPanelBody();
  }

  // ── Weekly export ──

  function triggerExport(chatId, exportType) {
    var store = AppCore.getStore();
    var chat = getChatObjById(chatId);
    var proj = AppCore.getActiveProject();
    if (!chat) return;
    var wk = AppCore.weekLabel();
    var now = new Date();
    var tzOffset = '+08:00';
    var exportDateTime = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + 'T' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') + tzOffset;

    var cml = MemoryModule.getCML(proj.id);

    var exportData = {
      exportMeta: {
        exportedAt: exportDateTime,
        exportType: exportType,
        week: wk,
        windowId: chatId,
        chatId: chatId,
        projectId: store.activeProject,
        schemaVersion: '2.0'
      },
      aiEmotionalMemories: cml.aiEmotionalMemories || [],
      userStarredMemories: cml.userStarredMemories || [],
      diaryAndLitterbox: cml.diaryAndLitterbox || []
    };

    var jsonStr = JSON.stringify(exportData, null, 2);
    chat.weeklyExports.push({
      week: wk,
      date: AppCore.fmtDate().iso,
      exportDateTime: exportDateTime,
      type: exportType,
      aemCount: (cml.aiEmotionalMemories || []).length,
      usmCount: (cml.userStarredMemories || []).length,
      dlbCount: (cml.diaryAndLitterbox || []).length,
      jsonData: jsonStr
    });

    MemoryModule.save(proj.id);
    MemoryModule.generateCoreOverview();

    renderMemoryPanelBody();
    var label = exportType === 'weekly_auto' ? '每周自动导出' : '手动导出';
    UIModule.toast(label + '完成');
    AppCore.saveStore();
  }

  function checkWeeklyExport() {
    var chat = AppCore.getActiveChatObj();
    if (!chat) return;
    var currentWeek = AppCore.weekLabel();
    var today = new Date();
    var alreadyExported = chat.weeklyExports && chat.weeklyExports.some(function(e) {
      return e.week === currentWeek && e.type === 'weekly_auto';
    });
    if (alreadyExported) return;
    if (today.getDay() === 1 || !chat._lastAutoExportCheck) {
      triggerExport(chat.id, 'weekly_auto');
      chat._lastAutoExportCheck = today.toISOString();
    }
  }

  // ── Render ──

  function renderAll() {
    renderHome();
    renderProjectList();
    renderChatMessages();
    renderBookshelf();
    renderDiary();
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: function() {},
    exportData: exportAllData,
    importData: importAllData,
    executeImport: executeImport,
    clearAll: clearAll,
    handleMemoryImport: handleMemoryImport,
    importMemoriesJSON: importMemoriesJSON,
    triggerExport: triggerExport,
    checkWeeklyExport: checkWeeklyExport,
    renderAll: renderAll
  };

})();

AppCore.register('backup', BackupModule);
