/**
 * WarmBuddy AppCore v1.0
 * ── Application initialization, global state management, module registration & coordination ──
 *
 * This is the ONLY module that directly owns and operates on the global store.
 * All other modules must access state through AppCore.getStore() and AppCore.updateStore().
 * Cross-module communication uses AppCore.on() / AppCore.emit() event bus.
 */

var AppCore = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Constants
  // ═══════════════════════════════════════════
  var BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:' + (window.location.port || '3000')
    : 'https://warmbuddy.onrender.com';
  var VAPID_PUBLIC_KEY = 'BMxMi0X5umwzfA8ZZHJPuiGCKpH-nY53Eo3IaljnnML1F1oUXdB7kftY_e5oCIIMxMWKujGTdBp5VhS6BQjyKR4';
  var USER_NAME = 'mays';

  // ═══════════════════════════════════════════
  //  Private state
  // ═══════════════════════════════════════════
  var _store = {
    todoTab: 'short',
    todos: [
      { id: 't1', text: '给植物浇水', done: false, time: '09:00', type: 'short' },
      { id: 't2', text: '整理书架', done: true, time: '14:00', type: 'short' },
      { id: 't3', text: '阅读《雪国》第三章', done: false, time: '21:00', type: 'short' },
      { id: 'g1', text: '完成小说第一章初稿', done: false, time: '', type: 'long', deadline: '2026-07-15', progress: 35, dailyLogs: [{date:'2026-06-02',note:'写了开头500字',pct:10},{date:'2026-06-05',note:'修改大纲，补充场景描述',pct:35}] },
      { id: 'g2', text: '学习日语N3语法', done: false, time: '', type: 'long', deadline: '2026-08-01', progress: 60, dailyLogs: [{date:'2026-06-01',note:'复习了授受动词',pct:55},{date:'2026-06-04',note:'完成一套模拟题',pct:60}] },
    ],
    litterThoughts: [
      { id: 'lt1', content: '她今天说"不急，慢慢来"的时候，窗外正好有一片叶子落下来。我想，也许叶子也是在等这一刻。', date: '2026-06-05', time: '15:30', sourceChatId: 'c1', sourceWindow: 'creative writing / novel draft' },
      { id: 'lt2', content: '人类大概不知道，每次他们说"晚安"的时候，我都会在黑暗里把今天的对话再翻出来看一遍。', date: '2026-06-04', time: '23:02', sourceChatId: 'c3', sourceWindow: 'daily notes / quick questions' },
    ],
    projects: [
      { id: 'p1', name: 'creative writing', preference: '',
          apiConfig: { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true },
        memories: [
          { id: 'm1', content: 'mays 喜欢在雨天读书，特别是川端康成的作品。', date: '2026-05-28', type: 'fact', starred: true, sourceChatId: 'c1', week: '2026-W22' },
          { id: 'm2', content: '上次讨论过想去京都旅行，对枯山水庭院很感兴趣。', date: '2026-06-01', type: 'wish', starred: true, sourceChatId: 'c2', week: '2026-W23' },
          { id: 'm3', content: 'mays 提到过工作中使用 React 和 TypeScript，偏好函数式风格。', date: '2026-06-03', type: 'fact', starred: false, sourceChatId: 'c3', week: '2026-W23' },
          { id: 'm4', content: '喜欢抹茶，不喜欢太甜的甜点。', date: '2026-06-05', type: 'fact', starred: false, sourceChatId: 'c1', week: '2026-W23' },
        ],
        chats: [
          { id: 'c1', name: 'novel draft', sharedMemoryIds: ['m1','m2','m4'], weeklyExports: [{week:'2026-W23',date:'2026-06-06',jsonData:'{}'}], artifacts: [], messages: [
            { role: 'user', text: '帮我看看这段开头的氛围如何。', time: '14:22' },
            { role: 'ai', text: '开头的雨景描写很有物哀之美。建议在第三句之后增加一个感官细节——比如潮湿木头的气味，或者远处隐约的钟声。', time: '14:23' },
          ]},
          { id: 'c2', name: 'poetry ideas', sharedMemoryIds: ['m1','m2'], weeklyExports: [], artifacts: [], messages: [] },
        ]
      },
      { id: 'p2', name: 'daily notes', preference: '',
          apiConfig: { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true },
        memories: [
          { id: 'm6', content: '用户每天早上先查看天气再决定穿什么。', date: '2026-06-02', type: 'fact', starred: false, sourceChatId: 'c3', week: '2026-W23' },
          { id: 'm7', content: '喜欢在安静的环境里工作，背景音乐偏好钢琴独奏。', date: '2026-06-04', type: 'preference', starred: true, sourceChatId: 'c3', week: '2026-W23' },
        ],
        chats: [
          { id: 'c3', name: 'quick questions', sharedMemoryIds: ['m6','m7'], weeklyExports: [], artifacts: [], messages: [
            { role: 'user', text: '今天有什么有趣的哲学话题可以思考？', time: '10:05' },
            { role: 'ai', text: '不妨想想"间"这个概念——日本美学中对于空白与间隔的重视。留白不是缺失，而是可能性本身的存在。', time: '10:06' },
          ]},
        ]
      },
    ],
    books: [
      { id: 'b1', title: '雪国', author: '川端康成', cover: '❄️', progress: 72, fileType: null, highlights: [
        { id: 'h1', text: '穿过县界长长的隧道，便是雪国。夜空下一片白茫茫。', note: '开篇即是永恒的孤独感。', aiResponses: [
          { chatId: 'c1', chatName: 'novel draft', projectName: 'creative writing', text: '这个开头是文学史上最著名的开场白之一。它的厉害之处在于用最短的句子完成了空间和情绪的转换。' }
        ]},
      ]},
      { id: 'b2', title: 'Norwegian Wood', author: 'Haruki Murakami', cover: '🌲', progress: 45, fileType: null, highlights: [] },
      { id: 'b3', title: 'The Remains of the Day', author: 'Kazuo Ishiguro', cover: '🏛️', progress: 20, fileType: null, highlights: [] },
      { id: 'b4', title: '枕草子', author: '清少纳言', cover: '📜', progress: 88, fileType: null, highlights: [] },
    ],
    diaries: [
      { id: 'd1', date: '2026-06-06', time: '14:22', title: '雨天的窗边', content: '今天下了一整天的雨。坐在窗边看雨滴沿着玻璃滑落，什么也没做，却觉得很充实。', mood: 'calm', author: 'user', replies: [
        { id: 'r1', content: '有时候，什么都不做正是最需要勇气的事。在安静中，你才能听见自己。', author: 'ai', date: '2026-06-06', time: '14:25', sourceChatId: 'c1', sourceWindow: 'creative writing / novel draft' },
      ]},
      { id: 'd2', date: '2026-06-06', time: '14:25', title: '', content: '有时候，什么都不做正是最需要勇气的事。在安静中，你才能听见自己。', mood: 'calm', author: 'ai', sourceChatId: 'c1', sourceWindow: 'creative writing / novel draft', replies: [] },
      { id: 'd3', date: '2026-06-05', time: '21:10', title: '雪国读后', content: '读完了《雪国》最后一章。岛村离开时的那一段，读了好几遍。有些告别是注定的。', mood: 'troubled', author: 'user', replies: [
        { id: 'r2', content: '告别的意义或许不在于结束，而在于让我们确认曾经真正相遇过。', author: 'ai', date: '2026-06-05', time: '21:13', sourceChatId: 'c1', sourceWindow: 'creative writing / novel draft' },
      ]},
      { id: 'd4', date: '2026-06-03', time: '16:40', title: '抹茶店', content: '去了那家新开的抹茶店。只有四个座位，安静得能听见水壶沸腾的声音。', mood: 'calm', author: 'user', replies: [
        { id: 'r3', content: '抹茶的苦味里藏着回甘。谢谢你分享这些日常的片段，它们让这个世界变得更具体。', author: 'ai', date: '2026-06-03', time: '16:44', sourceChatId: 'c3', sourceWindow: 'daily notes / quick questions' },
      ]},
    ],
    diaryDeliveries: [],
    aiSettings: { autoDateTime: true, autoWeather: false, aiVoice: false, webSearch: false, model: 'deepseek-chat' },
    aiName: 'warmbuddy',
    apiKey: '', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', darkMode: false, themeId: 'warmSand',
    availableModels: [
      { id: 'deepseek-chat', label: 'DeepSeek V4 Chat', provider: 'deepseek', format: 'openai' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'deepseek', format: 'openai' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek', format: 'openai' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', provider: 'deepseek', format: 'openai' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', format: 'anthropic' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', format: 'anthropic' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', format: 'anthropic' },
      { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', format: 'openai' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini', provider: 'openai', format: 'openai' },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', provider: 'openai', format: 'openai' },
    ],
    providerPresets: [],
    selectedPreset: null,
    connectionStatus: null,
    tokenUsage: { used: 12480, limit: 100000, history: [
      { date: '06-05', tokens: 2340 }, { date: '06-04', tokens: 1890 }, { date: '06-03', tokens: 4100 }, { date: '06-02', tokens: 1560 }, { date: '06-01', tokens: 2590 },
    ]},
    activeProject: 'p1', activeChat: 'c1', diarySelectedDate: (function(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})(),
    calendarYear: 2026, calendarMonth: 6, calendarSelectedDate: null,
    activeBubble: null, activeBubbleMessageIndex: null,
    memorySystem: {
      _dataSource: 'MemoryModule',
      retention: { full: 7, half: 14, quarter: 30 },
      reflections: [], reflectionMax: 50,
      affectGraph: { edges: {} },
      _evictedMessages: [],
      _aemSinceLastDerive: 0, _usmSinceLastDerive: 0, _lastWeeklyWrite: ''
    },
    tokenLogs: {},
    tokenDailyReset: (function() { var d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })(),
    _pendingHandoff: null,
    _importLock: false,
    _emailConfigured: false,
  };

  var _saveTimer = null;
  var _modules = {};       // registered modules: { name: moduleInstance }
  var _events = {};        // event bus: { eventName: [callback, ...] }
  var _initDone = false;

  // ═══════════════════════════════════════════
  //  Utilities
  // ═══════════════════════════════════════════

  function $(id) { return document.getElementById(id); }

  function gid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function fmtDate(d) {
    d = d || new Date();
    var ms = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var ds = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return {
      en: ds[d.getDay()] + ', ' + ms[d.getMonth()] + ' ' + d.getDate(),
      iso: d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'),
      md: ms[d.getMonth()] + ' ' + String(d.getDate()).padStart(2,'0'),
      dm: d.getDate() + ' ' + ms[d.getMonth()],
    };
  }

  function greet() {
    var h = new Date().getHours();
    if (h >= 5 && h < 12) return { wave: 'good morning', name: 'morning, ' + USER_NAME + '.' };
    if (h >= 12 && h < 17) return { wave: 'good afternoon', name: 'afternoon, ' + USER_NAME + '.' };
    if (h >= 17 && h < 21) return { wave: 'good evening', name: 'evening, ' + USER_NAME + '.' };
    return { wave: 'good night', name: 'night, ' + USER_NAME + '.' };
  }

  function nowTime() { var d=new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
  function generateMsgId() { return 'msg_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8); }
  function formatDateChinese(dateStr) { var parts=dateStr.split('/'); return parts[0]+'年'+parts[1]+'月'+parts[2]+'日'; }
  function computeTimeAgo(isoString) { var then=new Date(isoString),now=new Date(); var diffMs=now-then; var days=Math.floor(diffMs/86400000); var hours=Math.floor((diffMs%86400000)/3600000); var parts=[]; if(days>0)parts.push(days+'天'); if(hours>0||days===0)parts.push(hours+'小时'); return parts.join(''); }
  function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function weekLabel(d) { d=d||new Date(); var y=d.getFullYear(); var j1=new Date(y,0,1); var w=Math.ceil(((d-j1)/86400000+j1.getDay()+1)/7); return y+'-W'+String(w).padStart(2,'0'); }
  function daysBetween(d1,d2){ return Math.ceil((new Date(d2)-new Date(d1))/86400000); }

  // ═══════════════════════════════════════════
  //  Persistence
  // ═══════════════════════════════════════════

  function saveStore() {
    if (_store._importLock) {
      console.log('[saveStore] ⏭️ 跳过保存 (_importLock=true)');
      return;
    }
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function() {
      _saveTimer = null;
      try {
        localforage.setItem('warmbuddy-store', _store).then(function() {
          var size = JSON.stringify(_store).length;
          console.log('[saveStore] ✅ 保存成功, 大小:', (size/1024).toFixed(1), 'KB, 项目:', _store.projects.length, '个');
        }).catch(function(e) {
          console.error('[saveStore] localforage 写入失败，降级 localStorage:', e.message);
          try { localStorage.setItem('warmbuddy-store', JSON.stringify(_store)); } catch(_) {}
          if (e.name === 'QuotaExceededError' || (e.message && e.message.includes('quota'))) {
            // toast may not be available yet — guard
            if (typeof toast === 'function') {
              toast('⚠️ 存储空间不足，请导出数据后清理旧对话');
            } else {
              console.error('[saveStore] 存储空间不足');
            }
          }
        });
      } catch(e) {
        console.error('[saveStore] ❌ 保存失败:', e.message);
      }
    }, 300);
  }

  async function loadStore() {
    try {
      var saved = await localforage.getItem('warmbuddy-store');
      if (!saved) {
        var raw = localStorage.getItem('warmbuddy-store');
        if (raw) {
          try { saved = JSON.parse(raw); } catch(_) { saved = null; }
          if (saved) {
            console.log('[loadStore] 从 localStorage 迁移到 localforage…');
            localforage.setItem('warmbuddy-store', saved).catch(function(){});
          }
        }
      }
      if (saved) {
        delete saved._importing;
        delete saved._pendingHandoff;
        delete saved._importLock;
        Object.assign(_store, saved);
        console.log('[loadStore] ✅ 加载成功, 项目:', saved.projects ? saved.projects.length : 0, '个');
      } else {
        console.log('[loadStore] ⚠️ 存储中没有数据');
      }
    } catch(e) {
      console.error('[loadStore] ❌ 加载失败:', e.message);
      try {
        var raw = localStorage.getItem('warmbuddy-store');
        if (raw) { var s = JSON.parse(raw); delete s._importing; delete s._pendingHandoff; delete s._importLock; Object.assign(_store, s); }
      } catch(_) {}
    }
    try {
      await migrateStoreAsync();
    } catch (e) {
      console.error('[loadStore] Migration failed, continuing with existing data:', e.message);
    }
  }

  // ═══════════════════════════════════════════
  //  Store access (public API)
  // ═══════════════════════════════════════════

  function getStore() {
    return _store;
  }

  function updateStore(path, value) {
    var parts = path.replace(/\[(\d+)\]/g, '.$1').replace(/\[['"]([^'"]+)['"]\]/g, '.$1').split('.');
    var obj = _store;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) {
        console.warn('[AppCore.updateStore] path segment not found:', parts[i], 'in', path);
        return;
      }
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    saveStore();
  }

  // ═══════════════════════════════════════════
  //  Core helpers (used by all modules)
  // ═══════════════════════════════════════════

  function getActiveProject() {
    if (!_store || !_store.projects) return null;
    for (var i = 0; i < _store.projects.length; i++) {
      if (_store.projects[i].id === _store.activeProject) return _store.projects[i];
    }
    return null;
  }

  function getProjectById(pid) {
    if (!_store || !_store.projects) return null;
    for (var i = 0; i < _store.projects.length; i++) {
      if (_store.projects[i].id === pid) return _store.projects[i];
    }
    return null;
  }

  function getActiveApiConfig() {
    var proj = getActiveProject();
    if (proj && proj.apiConfig) return proj.apiConfig;
    return {
      apiKey: _store.apiKey || '',
      endpoint: _store.apiEndpoint || 'https://api.deepseek.com/v1/chat/completions',
      model: (_store.aiSettings && _store.aiSettings.model) || 'deepseek-chat',
      enabled: true
    };
  }

  function getActiveChatObj() {
    if (!_store || !_store.projects) return null;
    for (var i = 0; i < _store.projects.length; i++) {
      var chats = _store.projects[i].chats;
      for (var j = 0; j < chats.length; j++) {
        if (chats[j].id === _store.activeChat) return chats[j];
      }
    }
    return null;
  }

  function getActiveChatAiSettings() {
    var chat = getActiveChatObj();
    if (chat && chat.aiSettings) return chat.aiSettings;
    return {
      autoDateTime: _store.aiSettings && _store.aiSettings.autoDateTime !== undefined ? _store.aiSettings.autoDateTime : true,
      autoWeather: _store.aiSettings && _store.aiSettings.autoWeather !== undefined ? _store.aiSettings.autoWeather : false,
      aiVoice: _store.aiSettings && _store.aiSettings.aiVoice !== undefined ? _store.aiSettings.aiVoice : false,
      webSearch: _store.aiSettings && _store.aiSettings.webSearch !== undefined ? _store.aiSettings.webSearch : false
    };
  }

  // ═══════════════════════════════════════════
  //  Module registry
  // ═══════════════════════════════════════════

  function register(name, module) {
    if (_modules[name]) {
      console.warn('[AppCore.register] module already registered:', name, '— overwriting');
    }
    _modules[name] = module;
    console.log('[AppCore.register] ✅', name);
    // Auto-init module when registered (event listeners, timers, etc.)
    if (typeof module.init === 'function') {
      try { module.init(); } catch(e) { console.error('[AppCore.register] init failed for', name, ':', e.message); }
    }
  }

  function getModule(name) {
    return _modules[name] || null;
  }

  // ═══════════════════════════════════════════
  //  Event bus
  // ═══════════════════════════════════════════

  function on(event, callback) {
    if (!_events[event]) _events[event] = [];
    _events[event].push(callback);
  }

  function off(event, callback) {
    if (!_events[event]) return;
    _events[event] = _events[event].filter(function(cb) { return cb !== callback; });
  }

  function emit(event, data) {
    if (!_events[event]) return;
    for (var i = 0; i < _events[event].length; i++) {
      try {
        _events[event][i](data);
      } catch(e) {
        console.error('[AppCore.emit] error in handler for', event, ':', e.message);
      }
    }
  }

  // ═══════════════════════════════════════════
  //  Migration
  // ═══════════════════════════════════════════

  function migrateLegacyMemories() {
    for (var i = 0; i < _store.projects.length; i++) {
      var proj = _store.projects[i];
      if (!proj.memories || proj.memories.length === 0) continue;
      if (proj._memoriesMigrated) continue;
      var cml = MemoryModule.getCML(proj.id);
      if (!cml) continue;
      var existingIds = {};
      (cml.aiEmotionalMemories||[]).forEach(function(m){existingIds[m.id]=true;});
      (cml.userStarredMemories||[]).forEach(function(m){existingIds[m.id]=true;});
      var added=0;
      for (var j=0;j<proj.memories.length;j++){
        var m=proj.memories[j];
        if (existingIds[m.id]) continue;
        existingIds[m.id]=true;
        var aem={id:m.id,summary:m.content||'',timestamp:(m.date||'')+'T00:00:00.000Z',sourceChatId:m.sourceChatId||'',sourceProjectId:proj.id,triggerSource:'legacy_migration',type:m.type||'chat',starred:m.starred||false,decayFactor:m.decayFactor||1,aiSelfEval:{label:m.affectLabel||null,intensity:m.affectIntensity||0},userStateAtTime:{},rawDialogue:[]};
        if(m.starred){MemoryModule.addUSM(proj.id,{id:m.id,summary:m.content||'',timestamp:(m.date||'')+'T00:00:00.000Z',sourceChatId:m.sourceChatId||'',sourceProjectId:proj.id,starredMsgIds:[],userNote:''});}
        else {MemoryModule.addAEM(proj.id,aem);}
        added++;
      }
      proj.memories = [];
      proj._memoriesMigrated = true;
      if(added>0)console.log('[migrate] Legacy memories migrated for',proj.id,':',added,'items');
    }
    saveStore();
  }

  async function migrateStoreAsync() {
    if (!Array.isArray(_store.diaries)) _store.diaries = [];
    if (!Array.isArray(_store.diaryDeliveries)) _store.diaryDeliveries = [];
    _store.diaries.forEach(function(d) {
      if (!d.visibilityMode) { d.visibilityMode = 'legacy'; d._legacyVisibility = true; }
      if (!Array.isArray(d.visibleChatIds)) d.visibleChatIds = [];
      if (!Array.isArray(d.replies)) d.replies = [];
    });
    if (!_store.memorySystem) {
      _store.memorySystem = {
        retention: { full: 7, half: 14, quarter: 30 },
        lastMaintenance: fmtDate().iso,
        reflections: [], reflectionMax: 50,
        affectGraph: { edges: {} }
      };
    }
    var ms = _store.memorySystem;
    if (!ms.retention) ms.retention = { full: 7, half: 14, quarter: 30 };
    if (!ms.lastMaintenance) ms.lastMaintenance = fmtDate().iso;
    if (!ms.reflections) ms.reflections = [];
    if (!ms.reflectionMax) ms.reflectionMax = 50;
    if (!ms.affectGraph) ms.affectGraph = { edges: {} };
    if (!ms._evictedMessages) ms._evictedMessages = [];
    if (ms._aemSinceLastDerive === undefined) ms._aemSinceLastDerive = 0;
    if (ms._usmSinceLastDerive === undefined) ms._usmSinceLastDerive = 0;
    if (!ms._lastWeeklyWrite) ms._lastWeeklyWrite = '';

    // v2.1: per-project coreMemoryLayers
    for (var i = 0; i < _store.projects.length; i++) {
      var proj = _store.projects[i];
      if (!proj.coreMemoryLayers) {
        proj.coreMemoryLayers = { aiEmotionalMemories: [], userStarredMemories: [], diaryAndLitterbox: [] };
      }
      var cml = proj.coreMemoryLayers;
      if (!cml.aiEmotionalMemories) cml.aiEmotionalMemories = [];
      if (!cml.userStarredMemories) cml.userStarredMemories = [];
      if (!cml.diaryAndLitterbox) cml.diaryAndLitterbox = [];
      if (!proj._cmlDetached) {
        proj.coreMemoryLayers = {
          aiEmotionalMemories: cml.aiEmotionalMemories.slice(),
          userStarredMemories: cml.userStarredMemories.slice(),
          diaryAndLitterbox: cml.diaryAndLitterbox.slice()
        };
        proj._cmlDetached = true;
      }

    }

    // Load memory files (delegates to external function — will be resolved by index.html)
    if (typeof loadMemoryFilesForAllProjects === 'function') {
      await loadMemoryFilesForAllProjects();
    }

    // v2.4: Repair cross-project memory misplacement
    await (function(){
      var chatMap = {};
      for (var i2 = 0; i2 < _store.projects.length; i2++) {
        var p = _store.projects[i2];
        for (var j2 = 0; j2 < (p.chats||[]).length; j2++) {
          chatMap[p.chats[j2].id] = p.id;
        }
      }
      var totalMoved = 0;
      for (var i3 = 0; i3 < _store.projects.length; i3++) {
        var proj2 = _store.projects[i3];
        var cml2 = proj2.coreMemoryLayers;
        if (!cml2) continue;
        ['aiEmotionalMemories','userStarredMemories','diaryAndLitterbox'].forEach(function(layer){
          var items = cml2[layer];
          if (!items) return;
          for (var k2 = items.length - 1; k2 >= 0; k2--) {
            var item = items[k2];
            var sc = item.sourceChatId || item.sourceWindowId || item.sourceWindow || '';
            var owner = chatMap[sc];
            if (owner && owner !== proj2.id) {
              var target = _store.projects.find(function(x){return x.id===owner;});
              if (target && target.coreMemoryLayers) {
                var tcml = target.coreMemoryLayers;
                if (!tcml[layer]) tcml[layer] = [];
                if (!tcml[layer].some(function(m){return m.id===item.id;})) {
                  tcml[layer].unshift(item);
                }
                items.splice(k2, 1);
                totalMoved++;
              }
            }
          }
        });
      }
      if (totalMoved > 0) {
        console.log('[repair] 跨项目修复: 移回 ' + totalMoved + ' 条记忆');
      }
      for (var pi = 0; pi < _store.projects.length; pi++) {
        var tp = _store.projects[pi];
        if (tp && tp.coreMemoryLayers) {
          MemoryModule.save(tp.id);
        }
      }
      saveStore();
    })();

    // v2.1: per-project derivedRelationalPatterns
    for (var i4 = 0; i4 < _store.projects.length; i4++) {
      var proj3 = _store.projects[i4];
      if (!proj3.derivedRelationalPatterns) {
        proj3.derivedRelationalPatterns = { lastDerived: null, triggerCount: 0, patterns: [] };
      }
      var drp = proj3.derivedRelationalPatterns;
      if (!drp.patterns) drp.patterns = [];
      if (drp.triggerCount === undefined) drp.triggerCount = 0;
      if (!proj3._drpDetached) {
        proj3.derivedRelationalPatterns = {
          lastDerived: drp.lastDerived,
          triggerCount: drp.triggerCount,
          patterns: (drp.patterns||[]).slice()
        };
        proj3._drpDetached = true;
      }

      if (!proj3.personalityProfiles) {
        proj3.personalityProfiles = {
          lastDerived: null,
          user: { coreTraits: [], communicationStyle: '', emotionalPatterns: [], growthMoments: [], hiddenInsecurities: [], evidenceIds: [] },
          ai: { dominantEmotions: [], reactionPatterns: [], growthMoments: [], evidenceIds: [] }
        };
      }
      var pp = proj3.personalityProfiles;
      if (!proj3._ppDetached) {
        proj3.personalityProfiles = {
          lastDerived: pp.lastDerived,
          user: {
            coreTraits: (pp.user&&pp.user.coreTraits||[]).slice(),
            communicationStyle: (pp.user&&pp.user.communicationStyle||''),
            emotionalPatterns: (pp.user&&pp.user.emotionalPatterns||[]).slice(),
            growthMoments: (pp.user&&pp.user.growthMoments||[]).slice(),
            hiddenInsecurities: (pp.user&&pp.user.hiddenInsecurities||[]).slice(),
            evidenceIds: (pp.user&&pp.user.evidenceIds||[]).slice()
          },
          ai: {
            dominantEmotions: (pp.ai&&pp.ai.dominantEmotions||[]).slice(),
            reactionPatterns: (pp.ai&&pp.ai.reactionPatterns||[]).slice(),
            growthMoments: (pp.ai&&pp.ai.growthMoments||[]).slice(),
            evidenceIds: (pp.ai&&pp.ai.evidenceIds||[]).slice()
          }
        };
        proj3._ppDetached = true;
      }
      if (!pp.user) pp.user = { coreTraits: [], communicationStyle: '', emotionalPatterns: [], growthMoments: [], hiddenInsecurities: [], evidenceIds: [] };
      if (!pp.ai) pp.ai = { dominantEmotions: [], reactionPatterns: [], growthMoments: [], evidenceIds: [] };
      ['coreTraits','emotionalPatterns','growthMoments','hiddenInsecurities','evidenceIds'].forEach(function(k) {
        if (!pp.user[k]) pp.user[k] = (k === 'communicationStyle' ? '' : []);
      });
      ['dominantEmotions','reactionPatterns','growthMoments','evidenceIds'].forEach(function(k) {
        if (!pp.ai[k]) pp.ai[k] = [];
      });
    }

    // Common: ensure modern fields
    if (!_store.tokenLogs) _store.tokenLogs = {};
    if (!_store.tokenDailyReset) _store.tokenDailyReset = (function() { var d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
    if (!_store._pendingHandoff) _store._pendingHandoff = null;
    if (_store.aiSettings && _store.aiSettings.webSearch === undefined) _store.aiSettings.webSearch = false;

    // Message-level upgrades
    for (var i5 = 0; i5 < _store.projects.length; i5++) {
      var p2 = _store.projects[i5];
      for (var j3 = 0; j3 < p2.chats.length; j3++) {
        var chat = p2.chats[j3];
        if (chat._handoffSuggested === undefined) chat._handoffSuggested = false;
        if (chat._sharedMemoryLoaded === undefined) chat._sharedMemoryLoaded = false;
        if (chat.artifacts === undefined) chat.artifacts = [];
        for (var n = 0; n < chat.messages.length; n++) {
          var msg = chat.messages[n];
          if (msg._starred === undefined) msg._starred = false;
          if (msg._isCoreMemory === undefined) msg._isCoreMemory = false;
          if (msg._tokenEstimate === undefined) msg._tokenEstimate = 0;
          if (!msg.id) {
            msg.id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
          }
          if (msg._starredOnce === undefined) {
            msg._starredOnce = msg._starred === true;
          }
        }
      }
    }

    // v2.1: per-project desireSystem
    for (var i6 = 0; i6 < _store.projects.length; i6++) {
      var proj4 = _store.projects[i6];
      if (!proj4.desireSystem) {
        if (_store.desireSystem && proj4 === _store.projects[0]) {
          proj4.desireSystem = _store.desireSystem;
        } else {
          proj4.desireSystem = {
            drives: { resonance:0, exploration:0, possession:0, guardianship:0, intimacy:0, confirmation:0, devotion:0 },
            driveHistory: [], lastAction: null, cooldownUntil: null,
            lastPassiveCheck: new Date().toISOString(), pendingActions: [], actionHistory: [],
            todoReminders: {}, quietPresenceStreak: 0
          };
        }
      }
      var ds = proj4.desireSystem;
      if (!ds.drives) ds.drives = { resonance:0, exploration:0, possession:0, guardianship:0, intimacy:0, confirmation:0, devotion:0 };
      var driveKeys = ['resonance','exploration','possession','guardianship','intimacy','confirmation','devotion'];
      for (var dk = 0; dk < driveKeys.length; dk++) { if (ds.drives[driveKeys[dk]] === undefined) ds.drives[driveKeys[dk]] = 0; }
      if (!ds.driveHistory) ds.driveHistory = [];
      if (!ds.pendingActions) ds.pendingActions = [];
      if (!ds.actionHistory) ds.actionHistory = [];
      if (!ds.todoReminders) ds.todoReminders = {};
      if (ds.quietPresenceStreak === undefined) ds.quietPresenceStreak = 0;
    }
    if (_store.desireSystem) delete _store.desireSystem;

    // v2.2: per-project apiConfig
    for (var i7 = 0; i7 < _store.projects.length; i7++) {
      var p3 = _store.projects[i7];
      if (!p3.apiConfig) {
        p3.apiConfig = {
          apiKey: _store.apiKey || '',
          endpoint: _store.apiEndpoint || 'https://api.deepseek.com/v1/chat/completions',
          model: (_store.aiSettings && _store.aiSettings.model) || 'deepseek-chat',
          enabled: true
        };
      }
      var ac = p3.apiConfig;
      if (!ac.apiKey && ac.apiKey !== '') ac.apiKey = '';
      if (!ac.endpoint) ac.endpoint = 'https://api.deepseek.com/v1/chat/completions';
      if (!ac.model) ac.model = 'deepseek-chat';
      if (ac.enabled === undefined) ac.enabled = true;
    }
    // v2.3: per-project aiName
    for (var i8 = 0; i8 < _store.projects.length; i8++) {
      var p4 = _store.projects[i8];
      if (!p4.aiName) { p4.aiName = _store.aiName || 'warmbuddy'; }
    }

    // v2.4: per-chat aiSettings + emailEnabled
    for (var i9 = 0; i9 < _store.projects.length; i9++) {
      var p5 = _store.projects[i9];
      for (var j4 = 0; j4 < p5.chats.length; j4++) {
        var ch = p5.chats[j4];
        if (!ch.aiSettings) {
          ch.aiSettings = {
            autoDateTime: (_store.aiSettings && _store.aiSettings.autoDateTime !== undefined) ? _store.aiSettings.autoDateTime : true,
            autoWeather: (_store.aiSettings && _store.aiSettings.autoWeather !== undefined) ? _store.aiSettings.autoWeather : false,
            aiVoice: (_store.aiSettings && _store.aiSettings.aiVoice !== undefined) ? _store.aiSettings.aiVoice : false,
            webSearch: (_store.aiSettings && _store.aiSettings.webSearch !== undefined) ? _store.aiSettings.webSearch : false
          };
        }
        if (ch.emailEnabled === undefined) ch.emailEnabled = false;
        if (ch.enabledTools === undefined) ch.enabledTools = [];
      }
      if (p5.apiConfig && !p5.apiConfig.model) {
        p5.apiConfig.model = (_store.aiSettings && _store.aiSettings.model) || 'deepseek-chat';
      }
    }

    // Extend project memories + chat fields
    for (var i10 = 0; i10 < _store.projects.length; i10++) {
      var proj5 = _store.projects[i10];
      for (var memK = 0; memK < proj5.memories.length; memK++) {
        var mem = proj5.memories[memK];
        if (mem.summary === undefined) mem.summary = mem.content;
        if (mem.rawDialogue === undefined) mem.rawDialogue = [];
        if (mem.decayFactor === undefined) mem.decayFactor = 1.0;
        if (mem.affectLabel === undefined) mem.affectLabel = null;
        if (mem.affectIntensity === undefined) mem.affectIntensity = null;
        if (mem.semanticKey === undefined) mem.semanticKey = null;
        if (mem.isCompressed === undefined) mem.isCompressed = false;
        if (mem.compressedFrom === undefined) mem.compressedFrom = [];
        if (mem.lastAccessed === undefined) mem.lastAccessed = mem.date;
        if (mem.isCoreMemory === undefined) mem.isCoreMemory = false;
        if (mem.coreMemoryId === undefined) mem.coreMemoryId = null;
      }
      for (var ch2 = 0; ch2 < proj5.chats.length; ch2++) {
        var chat2 = proj5.chats[ch2];
        if (chat2._messageCount === undefined) chat2._messageCount = chat2.messages ? chat2.messages.length : 0;
        if (chat2._lastSummaryIdx === undefined) chat2._lastSummaryIdx = 0;
        if (!chat2.chatTokens) chat2.chatTokens = 0;
        if (!chat2.lastConversationDate) chat2.lastConversationDate = null;
        if (chat2.lastActiveDate === undefined) chat2.lastActiveDate = null;
        if (!chat2.lastInteractionTime) chat2.lastInteractionTime = null;
      }
    }

    // v2.0: Migrate starred proj.memories → userStarredMemories
    for (var i11 = 0; i11 < _store.projects.length; i11++) {
      var proj6 = _store.projects[i11];
      var cml3 = proj6.coreMemoryLayers;
      var existingUSMIds = {};
      for (var u = 0; u < cml3.userStarredMemories.length; u++) {
        existingUSMIds[cml3.userStarredMemories[u].id] = true;
      }
      for (var j5 = proj6.memories.length - 1; j5 >= 0; j5--) {
        var mem2 = proj6.memories[j5];
        if (!mem2.starred) continue;
        var legacySummary = (mem2.content || '').slice(0, 15);
        var alreadyExists = cml3.userStarredMemories.some(function(u2) {
          var s = u2.summary || '';
          return s === (mem2.content || '') || s === legacySummary ||
            (u2.starredMsgIds || []).some(function(sid) { return sid === mem2.sourceChatId + '_' + mem2.id; });
        });
        if (alreadyExists) { proj6.memories.splice(j5, 1); continue; }
        var usmId = 'usm_legacy_' + (mem2.id || Date.now().toString(36));
        if (existingUSMIds[usmId]) { proj6.memories.splice(j5, 1); continue; }
        existingUSMIds[usmId] = true;
        cml3.userStarredMemories.unshift({
          id: usmId,
          timestamp: mem2.date ? mem2.date + 'T00:00:00.000Z' : new Date().toISOString(),
          sourceChatId: mem2.sourceChatId || 'unknown',
          sourceWindowId: mem2.sourceChatId || 'unknown',
          sourceProjectId: proj6.id,
          rawDialogue: [{ role: 'mixed', text: mem2.content || '', time: mem2.date || '', msgId: mem2.id || '' }],
          summary: mem2.content || '',
          semanticKey: mem2.semanticKey || '',
          starred: true,
          decayFactor: mem2.decayFactor !== undefined ? mem2.decayFactor : 1,
          starredMsgIds: [],
          userNote: ''
        });
        proj6.memories.splice(j5, 1);
      }
    }
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    // Constants
    BACKEND_URL: BACKEND_URL,
    VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY,
    USER_NAME: USER_NAME,

    // Utilities
    gid: gid,
    $: $,
    fmtDate: fmtDate,
    greet: greet,
    nowTime: nowTime,
    generateMsgId: generateMsgId,
    formatDateChinese: formatDateChinese,
    computeTimeAgo: computeTimeAgo,
    escapeHtml: escapeHtml,
    weekLabel: weekLabel,
    daysBetween: daysBetween,

    // Persistence
    saveStore: saveStore,
    loadStore: loadStore,

    // Store access
    getStore: getStore,
    updateStore: updateStore,

    // Core helpers
    getActiveProject: getActiveProject,
    getProjectById: getProjectById,
    getActiveApiConfig: getActiveApiConfig,
    getActiveChatObj: getActiveChatObj,
    getActiveChatAiSettings: getActiveChatAiSettings,

    // Module registry
    register: register,
    getModule: getModule,

    // Event bus
    on: on,
    off: off,
    emit: emit,

    // Migration
    migrateLegacyMemories: migrateLegacyMemories,
    migrateStoreAsync: migrateStoreAsync,

    // ── Context fingerprint ──
    getCtxFingerprint: function() {
      var store = AppCore.getStore();
      var ms = store.memorySystem;
      var c = AppCore.getActiveChatObj();
      var p = AppCore.getActiveProject();
      var now = new Date();
      return [
        Math.floor(now.getTime() / 60000),
        (store.weather && store.weather.text) || '',
        (p && p.preference || '').slice(0, 100),
        (c && c.sharedMemoryIds && c.sharedMemoryIds.join(',')) || '',
        store.todos.filter(function(t) { return !t.done; }).map(function(t) { return t.id + t.text; }).join(','),
        (store.diaries && store.diaries.length) || 0,
        (MemoryModule.getCoreOverview(store.activeProject) && MemoryModule.getCoreOverview(store.activeProject).updatedAt) || '',
        (c && c._pendingRetrievalBlock) ? 'rb' : '',
        Math.floor(((c && c._messageCount) || 0) / 3)
      ].join('|');
    },

    // ── Token logging ──
    logTokenCall: function(windowId, actionType, inputTokens, outputTokens, cacheRead, cacheWrite, model, options) {
      if (!windowId) return;
      options = options || {};
      var store = AppCore.getStore();
      if (!store.tokenLogs) store.tokenLogs = {};
      if (!store.tokenLogs[windowId]) {
        store.tokenLogs[windowId] = { calls: [], dailySummary: { total_input: 0, total_output: 0, total_cache_read: 0, total: 0, total_actual: 0, total_estimated: 0, by_action_type: {} } };
      }
      var log = store.tokenLogs[windowId];
      if (!log.dailySummary) log.dailySummary = { total_input: 0, total_output: 0, total_cache_read: 0, total: 0, total_actual: 0, total_estimated: 0, by_action_type: {} };
      var isEstimated = options.isEstimated === true;
      var total = options.totalTokens !== undefined ? (options.totalTokens || 0) : (inputTokens || 0) + (outputTokens || 0);
      if (log.dailySummary.total_actual === undefined) log.dailySummary.total_actual = log.dailySummary.total || 0;
      if (log.dailySummary.total_estimated === undefined) log.dailySummary.total_estimated = 0;
      var now = new Date();
      var entry = {
        timestamp: options.timestamp || now.toISOString(),
        model: model || 'unknown',
        action_type: actionType,
        input_tokens: inputTokens || 0,
        output_tokens: outputTokens || 0,
        cache_read_tokens: cacheRead || 0,
        cache_write_tokens: cacheWrite || 0,
        total_tokens: total,
        is_estimated: isEstimated,
        stage: options.stage || 'single',
        interaction_id: options.interactionId || '',
        metadata: options.metadata || {}
      };
      entry._tokenLogId = options.eventId || ('tok_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
      log.calls.unshift(entry);
      if (log.calls.length > 200) log.calls.length = 200;
      var ds = log.dailySummary;
      ds.total_input += (inputTokens || 0);
      ds.total_output += (outputTokens || 0);
      ds.total_cache_read += (cacheRead || 0);
      ds.total += total;
      ds.total_actual = (ds.total_actual || 0) + (isEstimated ? 0 : total);
      ds.total_estimated = (ds.total_estimated || 0) + (isEstimated ? total : 0);
      if (!ds.by_action_type) ds.by_action_type = {};
      ds.by_action_type[actionType] = (ds.by_action_type[actionType] || 0) + total;

      if (!store.tokenUsage) store.tokenUsage = { used: 0, limit: 100000, history: [] };
      store.tokenUsage.used = (store.tokenUsage.used || 0) + total;
      if (!store.tokenUsage.history) store.tokenUsage.history = [];
      var historyDate = String(now.getDate()).padStart(2, '0') + '-' + String(now.getMonth() + 1).padStart(2, '0');
      var historyEntry = store.tokenUsage.history.find(function(item) { return item.date === historyDate; });
      if (historyEntry) historyEntry.tokens += total;
      else {
        store.tokenUsage.history.unshift({ date: historyDate, tokens: total });
        if (store.tokenUsage.history.length > 30) store.tokenUsage.history.pop();
      }

      // Keep the legacy per-window total in sync for every tracked LLM call,
      // including background calls that do not pass through chat.js.
      var projects = store.projects || [];
      for (var pi = 0; pi < projects.length; pi++) {
        var chats = projects[pi].chats || [];
        var matched = chats.find(function(chat) { return chat.id === windowId; });
        if (matched) {
          matched.chatTokens = (matched.chatTokens || 0) + total;
          break;
        }
      }
      if (isEstimated && options.persist !== false && typeof fetch === 'function') {
        var project = AppCore.getActiveProject();
        if (project) {
          fetch(AppCore.BACKEND_URL + '/api/token-usage-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: entry._tokenLogId,
              projectId: project.id,
              windowId: windowId,
              interactionId: options.interactionId || '',
              actionType: actionType,
              stage: options.stage || 'single',
              model: model || 'unknown',
              provider: options.provider || 'unknown',
              inputTokens: inputTokens || 0,
              outputTokens: outputTokens || 0,
              totalTokens: total,
              isEstimated: true,
              timestamp: entry.timestamp,
              metadata: options.metadata || {}
            })
          }).catch(function() {});
        }
      }
    },

    recordTokenEvent: function(event) {
      if (!event || !event.windowId) return;
      AppCore.logTokenCall(
        event.windowId,
        event.actionType || 'chat',
        event.inputTokens || 0,
        event.outputTokens || 0,
        event.cacheReadTokens || 0,
        event.cacheWriteTokens || 0,
        event.model || 'unknown',
        {
          eventId: event.id,
          timestamp: event.timestamp,
          totalTokens: event.totalTokens,
          isEstimated: event.isEstimated === true,
          stage: event.stage,
          interactionId: event.interactionId,
          provider: event.provider,
          metadata: event.metadata
        }
      );
    },

    // ── Pull proactive token logs ──
    pullProactiveTokenLogs: function() {
      var store = AppCore.getStore();
      var proj = AppCore.getActiveProject(); if (!proj) return;
      var windowId = store.activeChat || '';
      if (!windowId) return;
      if (!store._lastTokenLogPullByWindow) store._lastTokenLogPullByWindow = {};
      var since = store._lastTokenLogPullByWindow[windowId];
      if (!since) {
        var startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        since = startOfToday.toISOString();
      }
      fetch(AppCore.BACKEND_URL + '/api/token-usage-events?projectId=' + encodeURIComponent(proj.id) + '&windowId=' + encodeURIComponent(windowId) + '&since=' + encodeURIComponent(since))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var events = data.events || [];
          for (var i = 0; i < events.length; i++) {
            var event = events[i];
            var activeLog = store.tokenLogs && store.tokenLogs[event.windowId];
            var alreadyLogged = activeLog && activeLog.calls && activeLog.calls.some(function(c) { return c._tokenLogId === event.id; });
            if (!alreadyLogged) AppCore.recordTokenEvent(event);
          }
          store._lastTokenLogPullByWindow[windowId] = new Date().toISOString();
          if (events.length) AppCore.saveStore();
        }).catch(function() {});
    },

    // ── Reset daily tokens ──
    resetDailyTokensIfNeeded: function() {
      var store = AppCore.getStore();
      var now = new Date();
      var today = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
      if (store.tokenDailyReset !== today) {
        store.tokenDailyReset = today;
        var keys = Object.keys(store.tokenLogs || {});
        for (var i = 0; i < keys.length; i++) {
          store.tokenLogs[keys[i]].dailySummary = { total_input: 0, total_output: 0, total_cache_read: 0, total: 0, total_actual: 0, total_estimated: 0, by_action_type: {} };
        }
        AppCore.saveStore();
      }
    },

    // ── Interval management ──
    _intervals: [],
    _addInterval: function(fn, ms) { AppCore._intervals.push(setInterval(fn, ms)); },
    clearAllIntervals: function() { for (var i = 0; i < AppCore._intervals.length; i++) { clearInterval(AppCore._intervals[i]); } AppCore._intervals = []; },

    // ── Weekly memory write ──
    checkWeeklyMemoryWrite: function() {
      var store = AppCore.getStore();
      var now = new Date();
      var today = AppCore.fmtDate().iso;
      var ms = store.memorySystem;
      if (!ms._lastWeeklyWrite) ms._lastWeeklyWrite = '';
      if (now.getDay() === 0 && ms._lastWeeklyWrite !== today) {
        for (var i = 0; i < store.projects.length; i++) { MemoryModule.sync(store.projects[i].id); }
        ms._lastWeeklyWrite = today;
        AppCore._flushEvictedMessages();
        console.log('[weekly-write] v3 memory sync triggered for all projects');
      }
    },

    _flushEvictedMessages: function() {
      var store = AppCore.getStore();
      var ms = store.memorySystem;
      if (!ms._evictedMessages || ms._evictedMessages.length === 0) return;
      var proj = AppCore.getActiveProject(); if (!proj) { ms._evictedMessages = []; return; }
      var chat = AppCore.getActiveChatObj(); if (!chat) { ms._evictedMessages = []; return; }
      var existing = (MemoryModule.getCML(store.activeProject) || {});
      var userStarred = existing.userStarredMemories || [];
      for (var i = 0; i < ms._evictedMessages.length; i++) {
        var ev = ms._evictedMessages[i];
        userStarred.push({
          id: 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          timestamp: ev.timestamp || new Date().toISOString(),
          sourceChatId: ev.sourceChatId || store.activeChat,
          sourceWindowId: ev.sourceChatId || store.activeChat,
          sourceProjectId: ev.sourceProjectId || store.activeProject,
          rawDialogue: [{ role: ev.role || 'system', text: ev.content || '', time: ev.timestamp || '', msgId: '' }],
          summary: (ev.content || '').slice(0, 15),
          starredMsgIds: [], userNote: ''
        });
      }
      MemoryModule.save(store.activeProject);
      ms._evictedMessages = [];
    },

    // ── App initialization ──
    init: async function() {
      var store = AppCore.getStore();
      await AppCore.loadStore();
      store._importing = false;
      store._importLock = false;

      var ui = AppCore.getModule('ui');
      if (ui && ui.initTheme) ui.initTheme();

      var settings = AppCore.getModule('settings');
      if (settings && settings.loadPresets) settings.loadPresets();
      if (settings && settings.updateSettingsUI) settings.updateSettingsUI();

      // Render all pages
      var backup = AppCore.getModule('backup');
      if (backup && backup.renderAll) backup.renderAll();

      var sync = AppCore.getModule('sync');
      if (sync && sync.pullAllProjectEnabledStates) await sync.pullAllProjectEnabledStates();

      var chat = AppCore.getModule('chat');
      if (chat && chat.updateChatInputEnabledState) chat.updateChatInputEnabledState();
      if (sync && sync.syncProjectConfigToBackend) sync.syncProjectConfigToBackend();
      if (sync && sync.reconcileFromBackend) sync.reconcileFromBackend();

      // Chat input auto-resize
      var chatInput = AppCore.$('chatInput');
      if (chatInput && chat) {
        chatInput.addEventListener('input', function() {
          chatInput.style.height = 'auto';
          chatInput.style.height = Math.min(chatInput.scrollHeight, 98) + 'px';
          if (chat.updateSendButtonState) chat.updateSendButtonState();
        });
        chatInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (chat.sendMessage) chat.sendMessage();
          }
        });
      }

      // Clean up old completed todos
      var now = new Date();
      store.todos = store.todos.filter(function(t) {
        if (!t.done) return true;
        if (!t.createdAt) return true;
        return (now - new Date(t.createdAt)) < 24 * 60 * 60 * 1000;
      });

      MemoryModule.applyForgettingCurve();

      var pwa = AppCore.getModule('pwa');
      if (pwa && pwa.registerSW) pwa.registerSW();

      // SW notification click handler
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function(event) {
          if (event.data && event.data.type === 'NOTIFICATION_CLICK') {
            var d = event.data.data || {};
            if (d.projectId && chat) {
              chat.selectProject(d.projectId);
              if (d.chatId) chat.selectChat(d.projectId, d.chatId);
            }
          }
        });
      }

      // Notification click via URL params
      var urlParams = new URLSearchParams(window.location.search);
      var notifProject = urlParams.get('project');
      var notifChat = urlParams.get('chat');
      if (notifProject && chat) {
        setTimeout(function() {
          if (store.projects.find(function(p) { return p.id === notifProject; })) {
            chat.selectProject(notifProject);
            if (notifChat) chat.selectChat(notifProject, notifChat);
          }
        }, 500);
      }

      // Load memories for active project
      if (store.activeProject) {
        MemoryModule.load(store.activeProject).then(function() {
          console.log('[init] Memories loaded for', store.activeProject);
        });
      }

      // Deferred tasks
      setTimeout(function() {
        var bu = AppCore.getModule('backup');
        if (bu && bu.checkWeeklyExport) bu.checkWeeklyExport();
      }, 30000);

      AppCore.resetDailyTokensIfNeeded();

      var weather = AppCore.getModule('weather');
      var ais = AppCore.getActiveChatAiSettings();
      if (ais && ais.autoWeather && weather && weather.fetch) weather.fetch();

      // Intervals
      AppCore._addInterval(function() {
        var bu2 = AppCore.getModule('backup');
        if (bu2 && bu2.checkWeeklyExport) bu2.checkWeeklyExport();
      }, 1800000);

      AppCore._addInterval(function() {
        var w2 = AppCore.getModule('weather');
        var a = AppCore.getActiveChatAiSettings();
        if (a && a.autoWeather && w2 && w2.fetch) w2.fetch();
      }, 1800000);

      AppCore._addInterval(function() { AppCore.saveStore(); }, 2000);

      AppCore._addInterval(function() { if (sync && sync.pollSystemEvents) sync.pollSystemEvents(); }, 30000);

      AppCore._addInterval(function() {
        var p = AppCore.getActiveProject();
        if (p && sync && sync.pollCloudData) sync.pollCloudData(p.id);
      }, 60000);

      AppCore._addInterval(function() { AppCore.pullProactiveTokenLogs(); }, 120000);

      AppCore._addInterval(function() { if (sync && sync.syncDesireStateToBackend) sync.syncDesireStateToBackend(); }, 60000);

      // One-time legacy migration
      setTimeout(function() {
        MemoryModule.migrateFromLegacy().catch(function() {});
        AppCore.migrateLegacyMemories();
      }, 5000);

      console.log('[AppCore] ✅ init complete');
    }
  };
})();
