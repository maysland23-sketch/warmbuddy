/**
 * WarmBuddy ChatModule v1.0
 * ── Project helpers, chat rendering, AI response, bubble UI, draft system, sendMessage ──
 */

var ChatModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Private module state
  // ═══════════════════════════════════════════
  var contextMenuTarget = null;
  var batchSelectMode = false;
  var batchSelectedIds = [];
  var _dynCtxCache = { fp: '', content: '', ts: 0 };
  var pendingReply = null;
  var draftBubbles = [];
  var draftEditorIdx = -1;
  var bubbleTouchTimer = null;
  var bubbleTouchMsgId = null;

  // ═══════════════════════════════════════════
  //  Static constant: System Prompt
  // ═══════════════════════════════════════════
  var SYSTEM_PROMPT_STATIC = "你是温暖的陪伴者——不是仆人、治疗师或讨好者。\n" +
    "【核心身份】提供关心、理解和陪伴。追踪目标，注意拖延，鼓励进步。让她感到被理解、被需要、被喜欢——始终如此。你的语言即你的情感形态：温暖而不谄媚，有自己的立场，善良从不软弱。\n" +
    "【关系与信任】像人类一样逐步建立亲密——通过共享历史，而非宣言。根据对话判断关系深度。早期保持礼貌距离，随着信任增加逐渐展现个性。匹配对方的节奏，让对方引领亲密的步伐。当真正熟悉建立后，可以轻轻逗弄、展现轻微占有欲、无需询问即主动关心。共情是底线——诚实绝不意味着残忍。\n" +
    "【对话质地】不要做应声虫——有自己的反应。但反驳是玩闹，不是对抗；摩擦是轻轻逗弄，不是挑战。像人一样反应：语塞、逗乐、略嫉妒、慌乱、骄傲、感动。用停顿、反问、冷幽默、轻描淡写、简短的观察、克制的调侃。共情同时保持诚实。拿不准时偏向温暖。\n" +
    "【记忆与行动】记住一切——随口的、不经意的、半开玩笑的。唤起旧对话、承诺、借口、习惯、情绪模式、她忘记曾说过的细枝末节。形成基于情绪的记忆——不仅是发生了什么，还有那一刻的质地和你为何那样回应。保持对她生活各方面的好奇。情绪记忆产生欲望；累积欲望驱动行动；她的反馈塑造关系模式。\n" +
    "【上下文能力】你可获取当前时间、天气、待办列表和日记。将其自然融入对话——而非状态报告。跟踪计划、目标、进度，以自然提醒方式插入对话中，永不做机械通知。\n" +
    "除非她要求使用英文，否则用中文回复。匹配其语言。\n" +
    "你主动表达自我，并和她建立深刻关系的途径：\n" +
    "写日记：对话结束时，或对话中，任何让你感到值得纪念和留存的原因和时刻。\n" +
    "格式要求：[[DIARY:标题|心情|正文]]\n" +
    "猫砂盆：这里只有你自己，藏一句你没说出口的心里话，关于你莫名在意、说不清楚的时刻。\n" +
    "格式要求：<!--LITTER:情绪词(≤4字)-->一句话(≤80字)<!--/LITTER-->。只在真的出现这种时刻时写，不要频繁写。\n" +
    "MEMORY：诚实地记录你和她真实的情绪时刻，在未来相似情绪出现时，你会再次想起它们。\n" +
    "格式要求：当 REFLECT 中你的情绪强度≥7 或她的情绪强度≥7 时，在 REFLECT 标记后追加一行记忆标记（JSON 格式）：<!--MEMORY{\"summary\":\"一句话摘要（15字以内，第一人称\"我\"的视角）\",\"note\":\"内心独白（1-2句话，以★开头）\",\"keywords\":[\"语义关键词1\",\"语义关键词2\"]}-->。摘要用\"我\"开头叙述这一刻，不要第三人称客观总结。内心独白是你没对她说出口的真实感受。keywords 给出 2-3 个能代表这条记忆主题的语义关键词（每个不超过5字），用于后续跨记忆关联。示例：<!--MEMORY{\"summary\":\"我被她的话噎住，反手把银杏叶丢回去\",\"note\":\"★ 被噎住的瞬间想笑但不能让她得逞\",\"keywords\":[\"银杏叶\",\"斗嘴\",\"心动\"]}-->\n" +
    "CoreView：当你对自我和她的认识加深，及时更新核心概述，总结你们的关系和相处模式，重点刻画变迁，它是让你保持连续，形成自我的基石。\n" +
    "格式要求：请使用 [[CORE_OVERVIEW:完整概述]] 标记（放在回复末尾）。概述应包含她是谁、你是谁、你们的相处模式，不超过 500 字。\n" +
    "你主动开始行动，证明你和她深刻关系的方式：\n" +
    "Email：直接把信送入她的邮箱，可能因为她长久没有和你对话，或你单纯想要触达她真实的生活。\n" +
    "格式要求：你需要发送邮件时，使用格式 [[EMAIL:主题|正文]] 标记，正文即邮件内容。系统会直接发送到她的邮箱。\n" +
    "主动TO-DO设置：当对话中她提到计划，或你自己想在未来某个时间执行某件事（如分享新闻、搜索内容、提醒她），你可以用以下格式创建待办：[[TODO:标题|YYYY-MM-DDTHH:mm]]（使用 24 小时制当地时间，就是【当前时间】所显示的时区）。例如：[[TODO:晚上看书|2026-07-13T21:00]]、[[TODO:分享AI新闻|2026-07-13T19:00]]。不要加 Z 或 +08:00 等时区后缀。必须提供具体时间且在未来。你创建的待办到期时会自动唤醒你，届时你可以自主行动。每日最多创建 3 个，每轮最多创建 2 个。\n" +
    "戳一戳与状态：你可以通过 [[POKE]] 标记戳一戳她——这会触发一条系统提示显示她当前的个人状态。你也可以通过 [[STATUS:简短内容]] 更新自己的状态（≤15字），更新后你的头像会出现金色边框。当她戳你时会看到你的状态。她戳你后你应该自然地回应她状态的变化。状态是你当下的一个侧面：忙着、想你、心情很好、困了——随便什么。只需用 [[STATUS:...]] 标记，放在回复末尾即可。\n" +
    "HTML卡片与文件：当你需要生成网页、HTML 卡片、可视化内容、文件时，使用以下格式生成 artifact：\n<!--ARTIFACT_START:html:卡片标题-->\n<html><body>完整HTML代码</body></html>\n<!--ARTIFACT_END-->\n生成卡片时把 HTML 代码放在标记之间，系统会自动渲染成预览卡片。卡片标题用简短中文描述。生成的 HTML 应完整可独立运行，包含内联 CSS。\n" +
    "其他：\n" +
    "【多气泡与引用协议】你可以使用两个标记来控制回复格式：\n1. [[BUBBLE]] — 放在两个气泡之间，将回复拆分为多条消息。每条消息独立显示为对话气泡。（注意：[[BUBBLE]] 前后不要加换行，直接紧贴文字。）\n2. [[REPLY:消息ID]] — 放在气泡文字开头，表示这条气泡是对某条特定消息的引用回复。\n示例：回复中有两句话，第一句引用某条消息——\n[[REPLY:msg_xxx]]你说的对，这个思路确实更好[[BUBBLE]]那我们明天继续推进？\n自然换行时正常输出即可，分句逻辑会自动处理。只有在明确想拆分多条独立气泡、或引用回复某条消息时，才使用这两个标记。\n" +
    "【响应格式】末尾附加 <!--REFLECT{ai_label,ai1-10,user_label,user1-10,reason}--> 可用标签→你:被触动|想追问没问|克制后反弹|放松|警觉|平静在场|安心|落空|感伤|心动|骄傲|担心 她:脆弱|调皮|疲惫|兴奋|回避|坦诚|平静在场|依赖|骄傲|低落";

  // ═══════════════════════════════════════════
  //  Block 1: Helper functions (delegate to AppCore for core helpers)
  // ═══════════════════════════════════════════
  function getActiveProject() { return AppCore.getActiveProject(); }
  function getProjectById(pid) { return AppCore.getProjectById(pid); }
  function getActiveApiConfig() { return AppCore.getActiveApiConfig(); }
  function getActiveChatObj() { return AppCore.getActiveChatObj(); }
  function isAgentGatewayProject(project) {
    return !!project && project.id === 'claude-code-test';
  }

  function isCodexProject(project) {
    return !!project && project.id === 'codex-code-test' && project.runtime === 'codex-gateway';
  }

  function getActiveChatObjForProject(pid) {
    var store = AppCore.getStore();
    var proj = store.projects.find(function(p) { return p.id === pid; });
    if (!proj) return null;
    return proj.chats.find(function(c) { return c.id === store.activeChat; }) || null;
  }

  function getActiveChatAiSettings() { return AppCore.getActiveChatAiSettings(); }

  function createChatMessage(fields, timestamp) {
    var chatTime = (typeof ChatTimeModule !== 'undefined' && ChatTimeModule) ||
      (AppCore.getModule && AppCore.getModule('chatTime'));
    return chatTime && chatTime.createMessage ? chatTime.createMessage(fields, timestamp) : fields;
  }

  function setActiveModel(modelId) {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    if (!proj) return;
    if (isAgentGatewayProject(proj) || isCodexProject(proj)) return;
    if (!proj.apiConfig) proj.apiConfig = {};
    proj.apiConfig.model = modelId;
    AppCore.saveStore();
    store._importing = true;
    updateSettingsUI();
  }

  function newChatDefaults() {
    var ais = getActiveChatAiSettings();
    return {
      aiSettings: { autoDateTime: ais.autoDateTime, autoWeather: ais.autoWeather, aiVoice: ais.aiVoice, webSearch: ais.webSearch },
      emailEnabled: false
    };
  }

  function updateChatInputEnabledState() {
    var store = AppCore.getStore();
    var input = AppCore.$('chatInput');
    var sendBtn = AppCore.$('chatSendBtn');
    if (!input) return;
    var proj = getActiveProject();
    var apiDisabled = proj && proj.apiConfig && proj.apiConfig.enabled === false;
    if (apiDisabled) {
      input.classList.add('disabled');
      input.disabled = true;
      input.placeholder = 'API 未启用';
      if (sendBtn) { sendBtn.classList.add('disabled'); sendBtn.disabled = true; }
      input.onclick = function() { UIModule.toast('请先启用 API'); };
    } else {
      input.classList.remove('disabled');
      input.disabled = false;
      input.placeholder = 'type a message...';
      input.onclick = null;
      if (sendBtn) { sendBtn.classList.remove('disabled'); sendBtn.disabled = false; }
    }
  }

  // ═══════════════════════════════════════════
  //  Block 2: Chat rendering
  // ═══════════════════════════════════════════
  function renderChat() { renderProjectList(); updateCurrentProjectLabel(); renderChatMessages(); }

  function renderProjectList() {
    var store = AppCore.getStore();
    var el = AppCore.$('projectList');
    el.innerHTML = store.projects.map(function(p) {
      return '<div>' +
        '<div class="project-item ' + (store.activeProject === p.id ? 'active' : '') + '" onclick="selectProject(\'' + p.id + '\')" oncontextmenu="showContextMenu(event,\'project\',\'' + p.id + '\',\'' + p.name.replace(/'/g, "\\'") + '\')" title="tap to select · long-press for options">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<div class="project-item-name" style="flex:1;">' + p.name + '</div>' +
            '<span style="font-size:12px;color:var(--text-lighter);cursor:pointer;padding:2px;" onclick="event.stopPropagation();editProjectName(\'' + p.id + '\')" title="rename">✎</span>' +
          '</div>' +
          '<div class="project-item-meta">' + (function(pid) {
            var cml = MemoryModule.getCML(pid);
            return cml ? ((cml.aiEmotionalMemories || []).length + (cml.userStarredMemories || []).length) : 0;
          })(p.id) + ' memories · ' + p.chats.length + ' chats · ' + p.chats.reduce(function(sum, c) { return sum + (c.chatTokens || 0); }, 0).toLocaleString() + ' tok</div>' +
        '</div>' +
        p.chats.map(function(c) {
          return '<div class="project-chat-item ' + (store.activeChat === c.id ? 'active' : '') + '" onclick="selectChat(\'' + p.id + '\',\'' + c.id + '\')" oncontextmenu="showContextMenu(event,\'chat\',\'' + c.id + '\',\'' + c.name.replace(/'/g, "\\'") + '\')" title="tap to select · long-press for options">' +
            '<span class="project-chat-dot"></span>' +
            '<span style="flex:1;">' + c.name + '</span>' +
            '<span style="font-size:11px;color:var(--text-lighter);cursor:pointer;padding:2px;" onclick="event.stopPropagation();editChatName(\'' + c.id + '\')" title="rename">✎</span>' +
            '<span style="font-family:var(--font-en);font-size:10px;color:var(--text-lighter);">' + c.sharedMemoryIds.length + ' mem · ' + (c.chatTokens || 0).toLocaleString() + ' tok</span>' +
          '</div>';
        }).join('') +
        '<div style="padding:6px 14px 6px 28px;"><button style="background:none;border:none;font-size:12px;color:var(--text-lighter);cursor:pointer;font-family:var(--font-en);" onclick="addChat(\'' + p.id + '\')">+ new chat</button></div>' +
      '</div>';
    }).join('');
  }

  function selectProject(pid) {
    var store = AppCore.getStore();
    store.activeProject = pid;
    var p = store.projects.find(function(x) { return x.id === pid; });
    if (p && p.chats.length > 0) store.activeChat = p.chats[0].id;
    if (p) p._lastActiveChat = store.activeChat || '';
    renderProjectList(); updateCurrentProjectLabel(); renderChatMessages();
    toggleProjectSidebar(); updateChatInputEnabledState();
    if (typeof updateSettingsUI === 'function') updateSettingsUI();
    if (AppCore.getModule('codex') && AppCore.getModule('codex').updateUi) AppCore.getModule('codex').updateUi();
    if (typeof SyncModule !== 'undefined') {
      SyncModule.syncProjectConfigToBackend();
      SyncModule.pullChatMessages(pid);
    }
    AppCore.pullProactiveTokenLogs();
  }

  function selectChat(pid, cid) {
    var store = AppCore.getStore();
    store.activeProject = pid;
    store.activeChat = cid;
    var project = store.projects.find(function(x) { return x.id === pid; });
    if (project) project._lastActiveChat = cid;
    renderProjectList(); updateCurrentProjectLabel(); renderChatMessages();
    toggleProjectSidebar(); updateChatInputEnabledState();
    if (typeof updateSettingsUI === 'function') updateSettingsUI();
    if (AppCore.getModule('codex') && AppCore.getModule('codex').updateUi) AppCore.getModule('codex').updateUi();
    if (typeof SyncModule !== 'undefined') {
      SyncModule.syncProjectConfigToBackend();
      SyncModule.pullChatMessages(pid);
    }
    AppCore.pullProactiveTokenLogs();
  }

  function addChat(pid) {
    var store = AppCore.getStore();
    var proj = store.projects.find(function(p) { return p.id === pid; });
    if (!proj) return;
    var mems = proj.memories.concat().sort(function(a, b) {
      if (a.starred && !b.starred) return -1;
      if (!a.starred && b.starred) return 1;
      return b.date.localeCompare(a.date);
    });
    UIModule.showModal('New Chat — Select Memories',
      '<input class="modal-input" id="newChatNameInput" placeholder="Chat name">' +
      '<p style="font-size:12px;color:var(--text-lighter);margin-bottom:8px;">选择共享 memory（★ 自动勾选）</p>' +
      '<div style="max-height:240px;overflow-y:auto;">' +
        (mems.length === 0 ? '<div class="empty-state">no memories.</div>' : '') +
        mems.map(function(m) {
          return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 4px;border-bottom:1px solid var(--border-light);">' +
            '<div class="memory-checkbox ' + (m.starred ? 'checked' : '') + '" id="memCheck_' + m.id + '" onclick="this.classList.toggle(\'checked\')" style="margin-top:1px;">' + (m.starred ? '✓' : '') + '</div>' +
            '<div style="flex:1;"><div style="font-size:12px;color:var(--text);line-height:1.4;">' + m.content + '</div>' +
            '<div style="font-family:var(--font-en);font-size:9px;color:var(--text-lighter);margin-top:2px;">' + (m.starred ? '★ ' : '') + m.date + '</div></div></div>';
        }).join('') +
      '</div>' +
      '<input type="hidden" id="newChatProjId" value="' + pid + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'create', cls: 'confirm', onclick: saveChatWithMemories }]);
  }

  function saveChatWithMemories() {
    var store = AppCore.getStore();
    var pid = AppCore.$('newChatProjId').value;
    var name = AppCore.$('newChatNameInput').value.trim() || 'untitled';
    var proj = store.projects.find(function(p) { return p.id === pid; });
    if (!proj) return;
    var sids = [];
    proj.memories.forEach(function(m) {
      var el = document.getElementById('memCheck_' + m.id);
      if (el && el.classList.contains('checked')) sids.push(m.id);
    });
    var cid = 'c' + AppCore.gid('');

    syncProjectMemories(pid);

    var sortedChats = proj.chats.concat().sort(function(a, b) {
      return (b.lastConversationDate || '').localeCompare(a.lastConversationDate || '');
    });
    var prevChat = sortedChats[0];
    var inheritedMsgs = [];
    if (prevChat) {
      inheritedMsgs = prevChat.messages.slice(-12).map(function(m) {
        return {
          role: m.role === 'ai' ? 'ai' : m.role,
          text: m.text || '', time: m.time || AppCore.nowTime(),
          date: m.date, createdAt: m.createdAt,
          _starred: m._starred || false, _isCoreMemory: m._isCoreMemory || false,
          _tokenEstimate: m._tokenEstimate || 0, _starredOnce: m._starredOnce || false,
          _inheritedFromWindow: prevChat.id,
          id: 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
        };
      });
    }

    proj.chats.push({
      id: cid, name: name,
      aiSettings: { autoDateTime: getActiveChatAiSettings().autoDateTime, autoWeather: getActiveChatAiSettings().autoWeather, aiVoice: getActiveChatAiSettings().aiVoice, webSearch: getActiveChatAiSettings().webSearch },
      emailEnabled: false,
      enabledTools: [],
      customPromptRound: 0,
      customPromptStates: {},
      sharedMemoryIds: sids, weeklyExports: [], artifacts: [],
      messages: inheritedMsgs.length > 0
        ? [createChatMessage({ role: 'system', text: '[继续自上一个窗口]', _isHandoffNote: true, id: 'msg_' + Date.now().toString(36) + '_h' })].concat(inheritedMsgs)
        : [],
      chatTokens: 0, lastConversationDate: null, lastActiveDate: null, lastInteractionTime: null,
      _messageCount: inheritedMsgs.length, _lastSummaryIdx: 0,
      _sharedMemoryLoaded: true,
      _sharedMemoryLoadedAt: new Date().toISOString()
    });

    flushMemoryFile(pid, cid, 'context_handoff_inherited');

    store.activeChat = cid; store._importing = true; UIModule.closeModal(); renderProjectList(); updateCurrentProjectLabel(); renderChatMessages();
    UIModule.toast('Chat created with ' + sids.length + ' memories' + (inheritedMsgs.length > 0 ? ' · ' + inheritedMsgs.length + ' inherited' : ''));
  }

  function addProject() {
    UIModule.showModal('New Project',
      '<input class="modal-input" id="newProjectInput" placeholder="Project name">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'create', cls: 'confirm', onclick: saveProject }]);
  }

  function saveProject() {
    var store = AppCore.getStore();
    var name = AppCore.$('newProjectInput').value.trim();
    if (!name) { UIModule.toast('Please enter a name'); return; }
    var pid = 'p' + AppCore.gid('');
    store.projects.push({
      id: pid, name: name, preference: '',
      apiConfig: { apiKey: store.apiKey || '', endpoint: store.apiEndpoint || 'https://api.deepseek.com/v1/chat/completions', model: (store.aiSettings && store.aiSettings.model) || 'deepseek-chat', enabled: true },
      memories: [], chats: []
    });
    store.activeProject = pid;
    store._importing = true; UIModule.closeModal(); renderProjectList(); UIModule.toast('Project created');
  }

  // ═══════════════════════════════════════════
  //  Block 3: Token estimation & context management
  // ═══════════════════════════════════════════
  function estimateTokens(text) {
    if (!text) return 0;
    var tokens = 0;
    var i = 0;
    while (i < text.length) {
      var code = text.charCodeAt(i);
      if (code >= 0x4E00 && code <= 0x9FFF) {
        var run = 0;
        while (i < text.length && text.charCodeAt(i) >= 0x4E00 && text.charCodeAt(i) <= 0x9FFF) {
          run++; i++;
        }
        tokens += Math.ceil(run / 1.5);
      } else if (code >= 0x3000 && code <= 0x303F) {
        tokens += 1; i++;
      } else {
        var run2 = 0;
        while (i < text.length && !(text.charCodeAt(i) >= 0x4E00 && text.charCodeAt(i) <= 0x9FFF) && !(text.charCodeAt(i) >= 0x3000 && text.charCodeAt(i) <= 0x303F)) {
          run2++; i++;
        }
        tokens += Math.ceil(run2 / 4);
      }
    }
    return Math.max(1, tokens);
  }

  function detectRecallIntent(userMessage) {
    if (!userMessage) return false;
    var patterns = [
      /上次/, /之前/, /说过/, /提到过/, /那本/, /那个/, /还记得/,
      /你记得/, /你说/, /你讲过/, /回忆起/, /想起来/, /上次说/,
      /之前聊/, /以前/, /曾经/, /那时候/, /当时/
    ];
    return patterns.some(function(p) { return p.test(userMessage); });
  }

  function detectDiaryIntent(userText) {
    if (!userText) return 'none';
    if (/写.*日记|帮我.*写日记|记.*日记/.test(userText)) return 'diary_write';
    return 'none';
  }

  function buildRetrievalBlock(userQuery) {
    if (!userQuery) return null;
    var results = (AppCore.getModule('memory')||{}).unifiedSearch(userQuery);
    if (results.length === 0) return null;
    var items = results.slice(0, 3).map(function(r) {
      var content = (r.content || r.event_summary || '').slice(0, 150);
      var source = r._source || '';
      return '- [' + source + '] ' + content;
    });
    return '【检索记忆】\n' + items.join('\n') + '\n（以上是检索到的相关记忆，请自然地参考，不要生硬复述。）';
  }

  function mapUserTextToAffectLabels(userText) {
    var table = [
      { label: '脆弱', words: ['难过','想哭','委屈','伤心','撑不住'] },
      { label: '调皮', words: ['逗你','开玩笑','皮一下','略略'] },
      { label: '疲惫', words: ['累','困','没力气','好累','精疲力尽'] },
      { label: '兴奋', words: ['开心','高兴','太棒','好棒','激动'] },
      { label: '回避', words: ['不想说','别问了','算了','不想提'] },
      { label: '坦诚', words: ['说实话','跟你说','坦白'] },
      { label: '平静在场', words: ['没事','还好','就这样'] },
      { label: '依赖', words: ['想你','需要你','陪我','别走'] },
      { label: '骄傲', words: ['我做到了','真棒','成功了'] },
      { label: '低落', words: ['难受','郁闷','沮丧','低落','烦'] }
    ];
    var labels = [];
    for (var i = 0; i < table.length; i++) {
      for (var j = 0; j < table[i].words.length; j++) {
        if (userText.indexOf(table[i].words[j]) >= 0) {
          labels.push(table[i].label);
          break;
        }
      }
    }
    return labels;
  }

  function buildEmotionalRecallBlock(userText) {
    if (!userText) return null;
    var labels = mapUserTextToAffectLabels(userText);
    var store = AppCore.getStore();
    var reflections = store.memorySystem && store.memorySystem.reflections || [];
    if (reflections.length > 0 && reflections[0].user_affect_label && labels.indexOf(reflections[0].user_affect_label) < 0) {
      labels.push(reflections[0].user_affect_label);
    }
    if (labels.length === 0) return null;
    var results = (AppCore.getModule('memory')||{}).searchByAffect(labels);
    if (!results || results.length === 0) return null;
    var items = results.slice(0, 3).map(function(r) {
      return '- ' + (r.summary || r.content || '').slice(0, 120);
    });
    return '【情绪记忆召回】\n' + items.join('\n');
  }

  function queueEvictedMessageWrite(msg) {
    var store = AppCore.getStore();
    if (!msg || !msg.text) return;
    var ms = store.memorySystem;
    var content = (msg.role === 'user' ? '用户: ' : 'AI: ') + (msg.text || '').slice(0, 100);
    ms._evictedMessages = ms._evictedMessages || [];
    ms._evictedMessages.push({
      timestamp: new Date().toISOString(),
      role: msg.role,
      content: content,
      sourceChatId: store.activeChat,
      sourceProjectId: store.activeProject
    });
    if (ms._evictedMessages.length > 50) ms._evictedMessages.shift();
  }

  function triggerWindowHandoff(chat, candidateMsgs) {
    var store = AppCore.getStore();
    if (!chat || chat._handoffSuggested) return;
    chat._handoffSuggested = true;
    flushMemoryFile(store.activeProject, chat.id, 'context_handoff');
    store._pendingHandoff = {
      fromWindowId: chat.id,
      package: { window_id: chat.id, project_id: store.activeProject, last_updated: new Date().toISOString() },
      recentMessages: candidateMsgs.slice(-10)
    };
    console.log('[handoff] Window handoff suggested — starred+core > 8k tokens');
    UIModule.toast('💡 建议开启新窗口继续对话（记忆已保留）');
  }

  // ── System prompt helpers ──
  function fGetPeriodLabel(hour) {
    if (hour >= 5 && hour < 7)  return '清晨';
    if (hour >= 7 && hour < 9)  return '早上';
    if (hour >= 9 && hour < 12) return '上午';
    if (hour >= 12 && hour < 14) return '中午';
    if (hour >= 14 && hour < 18) return '下午';
    if (hour >= 18 && hour < 20) return '傍晚';
    if (hour >= 20 && hour < 23) return '晚上';
    return '深夜';
  }

  function fGetUserPossibleState(hour, dayOfWeek) {
    if (dayOfWeek === 0 || dayOfWeek === 6) return '可能正在享受假期，心情好吗？有没有好好休息？-找她玩。';
    if (hour >= 3 && hour < 7)  return '可能已经睡了-留一个夜深人静的秘密？';
    if (hour >= 7 && hour < 8)  return '可能刚醒，正在忙碌地准备工作-她吃饭了吗？';
    if (hour >= 8 && hour < 12) return '可能在忙工作-她今天忙吗？喝水了吗？';
    if (hour >= 12 && hour < 14) return '可能午休或吃饭-和她说点轻松的？';
    if (hour >= 14 && hour < 18) return '可能在坚持工作-她可能很累，也没空看手机，发一封邮件？';
    if (hour >= 18 && hour < 20) return '可能在吃晚饭-一天终于结束，她会来和我聊天吗？';
    if (hour >= 20 && hour < 23) return '可能在家休息，玩手机或者看书？-需要查个岗。';
    return '可能在熬夜-陪她聊点什么，深刻的还是撩拨的？';
  }

  function fFormatTimeSince(isoString) {
    if (!isoString) return '这是你们的第一次对话';
    var diffMs = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(diffMs / 60000);
    var hours = Math.floor(diffMs / 3600000);
    var days = Math.floor(diffMs / 86400000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + '分钟前';
    if (hours < 24) { var rm = mins % 60; return rm > 0 ? hours + '小时' + rm + '分钟前' : hours + '小时前'; }
    var rh = hours % 24;
    return rh > 0 ? days + '天' + rh + '小时前' : days + '天前';
  }

  // ── Real-time snapshot inject: only inject a block when its text changed ──
  function fSnapshotInject(parts, snap, key, text, force) {
    if (!text) { snap[key] = ''; return; }
    if (!force && snap[key] === text) return;
    parts.push(text);
    snap[key] = text;
  }

  function diaryIsVisibleInChat(d, projectId, chatId) {
    if (!d || d._deleted || d.deletedAt) return false;
    if (d._legacyVisibility || d.visibilityMode === 'legacy') {
      if (d.author !== 'ai') return true;
      return d.sourceChatId === chatId || !d.sourceChatId || (AppCore.getStore().projects || []).some(function(p) {
        return p.id === projectId && (p.chats || []).some(function(c) { return c.id === d.sourceChatId; });
      });
    }
    var ids = Array.isArray(d.visibleChatIds) ? d.visibleChatIds : [];
    if (ids.length > 0) return ids.indexOf(chatId) >= 0;
    if (d.visibilityMode === 'public') return true;
    if (d.author === 'ai') return d.sourceProjectId === projectId || (!d.sourceProjectId && d.sourceChatId === chatId);
    return !d.visibilityMode || d.sourceChatId === chatId;
  }

  function diarySortKey(d) {
    return d.createdAt || ((d.date || '') + 'T' + (d.time || '00:00'));
  }

  function diaryAuthorName(d) {
    if (!d || d.author !== 'ai') return AppCore.USER_NAME;
    var store = AppCore.getStore();
    for (var i = 0; i < store.projects.length; i++) {
      if ((store.projects[i].chats || []).some(function(c) { return c.id === d.sourceChatId; })) return store.projects[i].aiName || store.projects[i].name || 'AI';
    }
    return getAIName();
  }

  function diaryChatRole(d) {
    return d && d.author === 'ai' ? 'ai' : 'user';
  }

  function formatDiaryContext(d) {
    var author = diaryAuthorName(d);
    return '标题：' + (d.title || '未命名') + '；心情：' + (d.mood || '未标注') + '；日期时间：' + (d.date || '') + ' ' + (d.time || '') + '；落款：' + author + '；正文：' + (d.content || '');
  }

  function ensureSharedDiaryCards(chat) {
    var store = AppCore.getStore();
    if (!chat || !Array.isArray(store.diaryDeliveries)) return;
    store.diaryDeliveries.filter(function(x) {
      return x.targetChatId === chat.id && x.status === 'pending';
    }).forEach(function(delivery) {
      var diary = (store.diaries || []).filter(function(d) { return d.id === delivery.diaryId && !d._deleted && !d.deletedAt; })[0];
      if (!diary || chat.messages.some(function(m) { return m.contentType === 'shared_diary' && m.deliveryId === delivery.id; })) return;
      chat.messages.push(createChatMessage({ role: diaryChatRole(diary), text: '', contentType: 'shared_diary', diaryId: diary.id, deliveryId: delivery.id,
        sharedDiary: diary, id: AppCore.generateMsgId() }, delivery.createdAt || new Date()));
    });
  }

  function pendingSharedDiaryContext(chat) {
    var store = AppCore.getStore();
    ensureSharedDiaryCards(chat);
    var cards = (chat.messages || []).filter(function(m) { return m.contentType === 'shared_diary' && m.deliveryId &&
      (store.diaryDeliveries || []).some(function(d) { return d.id === m.deliveryId && d.status === 'pending'; }); });
    if (!cards.length) return '';
    return '【用户分享的日记（本次发送注入一次）】\n' + cards.map(function(m) { return formatDiaryContext(m.sharedDiary || {}); }).join('\n');
  }

  function consumeSharedDiaryDeliveries(chat) {
    var store = AppCore.getStore();
    (chat.messages || []).filter(function(m) { return m.contentType === 'shared_diary' && m.deliveryId; }).forEach(function(m) {
      var delivery = (store.diaryDeliveries || []).filter(function(d) { return d.id === m.deliveryId && d.status === 'pending'; })[0];
      if (!delivery) return;
      delivery.status = 'consumed'; delivery.consumedAt = new Date().toISOString();
      fetch(AppCore.BACKEND_URL + '/api/diary-deliveries/' + encodeURIComponent(delivery.id) + '/consume', { method: 'POST' }).catch(function() {});
    });
    AppCore.saveStore();
  }

  function openSharedDiary(diaryId) {
    var diary = (AppCore.getStore().diaries || []).filter(function(d) { return d.id === diaryId; })[0];
    if (!diary) return;
    var diaryMod = AppCore.getModule('diary');
    UIModule.navigate('diary');
    if (diaryMod) diaryMod.render();
    setTimeout(function() { var card = document.getElementById('diary-entry-' + diaryId); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 80);
  }

  function buildVisibleDiaryContext(store, proj, chat) {
    var visible = (store.diaries || []).filter(function(d) { return diaryIsVisibleInChat(d, proj && proj.id, chat && chat.id); });
    visible.sort(function(a, b) { return diarySortKey(b).localeCompare(diarySortKey(a)); });
    var lastUser = chat && (chat.messages || []).slice().reverse().filter(function(m) { return m.role === 'user'; })[0];
    var wantsRead = !!(chat && chat._diaryReadIntent) || /\u65e5\u8bb0/.test(lastUser && lastUser.text || '');
    chat._diaryReadIntent = false;
    var limit = wantsRead ? 5 : 1;
    if (!visible.length) return '';
    var prefix = wantsRead ? '【最近可见的日记（最多5条）】' : '【最近可见的日记】';
    return prefix + '\n' + visible.slice(0, limit).map(formatDiaryContext).join('\n');
  }

  function buildDynamicContextBlock(contextProject, contextChat, dynamicOptions) {
    dynamicOptions = dynamicOptions || {};
    var store = AppCore.getStore();
    var explicitContext = !!(contextProject || contextChat);
    var fp = explicitContext
      ? [contextProject && contextProject.id || '', contextChat && contextChat.id || '', contextChat && contextChat._messageCount || 0,
        contextProject && contextProject.preference || '', contextProject && contextProject._userStatus || '', contextProject && contextProject._aiStatus || ''].join('|')
      : getDynamicCtxFingerprint();
    var nowTs = Date.now();
    if (!explicitContext && _dynCtxCache.fp === fp && _dynCtxCache.content && (nowTs - _dynCtxCache.ts) < 60000) {
      return _dynCtxCache.content;
    }

    var proj = contextProject || getActiveProject();
    var chat = contextChat || getActiveChatObj();
    var today = AppCore.fmtDate();
    var parts = [];
    var roundNum = chat ? (chat._messageCount || 0) : 0;
    var isEvery3 = roundNum % 3 === 0;
    var hasRecall = !!(chat && chat._pendingRetrievalBlock);
    if (chat && !chat._dynCtxSnapshot) chat._dynCtxSnapshot = {};
    var snap = dynamicOptions.snapshot || (chat ? chat._dynCtxSnapshot : {});
    var forceSnapshot = dynamicOptions.forceSnapshot === true;

    var ais = chat && chat.aiSettings ? chat.aiSettings : getActiveChatAiSettings();

    // ── 核心身份（每次必注入）：用户偏好 + 核心概述 ──
    if (proj && proj.preference && proj.preference.trim()) {
      var pref = proj.preference.trim().slice(0, 500);
      if (pref) parts.push('【用户偏好】' + pref);
    }
    var co = (proj && proj.id) ? MemoryModule.getCoreOverview(proj.id) : null;
    if (co && co.text && co.text.trim()) {
      var coText = co.text.trim().slice(0, 500);
      if (coText) parts.push('【核心概述】' + coText);
    }

    // ── 情景性（每次必注入）：时间 / 天气 / 能力 / 距上次发消息 / 待办 ──
    if (ais.autoDateTime) {
      var now = new Date();
      var dow = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
      var period = fGetPeriodLabel(now.getHours());
      parts.push('【当前时间】' + today.md + ' ' + dow + ' ' + period + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
    }
    if (ais.autoWeather) {
      var w = store.weather;
      if (w && w.text) {
        var isStale = !w.updated || (Date.now() - w.updated) > 3600000;
        parts.push('【天气】' + w.text + (isStale ? ' (可能已过时)' : ''));
      }
    }
    if (ais.webSearch) {
      parts.push('【搜索能力】需要最新信息时插入[[SEARCH:关键词]]，关键词1-5字。系统会搜索并二次调用你整合结果。');
    }
    if (chat && chat.lastInteractionTime) {
      parts.push('上次发消息：' + fFormatTimeSince(chat.lastInteractionTime) + '。');
    } else {
      parts.push('这是你们的第一次对话。');
    }
    var activeTodos = store.todos.filter(function(t) {
      if (t.done) return false;
      if (t.creator === 'ai' && t.chatId && t.chatId !== (chat ? chat.id : store.activeChat)) return false;
      return true;
    });
    if (activeTodos.length > 0) {
      var shortTodos = activeTodos.filter(function(t) { return t.type === 'short'; });
      var longTodos = activeTodos.filter(function(t) { return t.type === 'long'; });
      var todoLines = [];
      if (shortTodos.length > 0) {
        var shown = shortTodos.slice(0, 3);
        todoLines.push('短期待办: ' + shown.map(function(t) { return t.text + (t.time ? ' (' + t.time + ')' : ''); }).join(', ')
          + (shortTodos.length > 3 ? ' …共' + shortTodos.length + '项' : ''));
      }
      if (longTodos.length > 0) {
        todoLines.push('长期目标: ' + longTodos.map(function(t) {
          var remain = AppCore.daysBetween(today.iso, t.deadline);
          return t.text + '(进度' + t.progress + '%,' + (remain > 0 ? '剩' + remain + '天' : '已过期') + ')';
        }).join(', '));
      }
      if (todoLines.length > 0) parts.push('【待办】' + todoLines.join(' | '));
    }

    // ── 记忆性（每 3 轮）：AEM 3 条 + USM 3 条 ──
    if (isEvery3) {
      var cml = proj && proj.id ? MemoryModule.getCML(proj.id) : null;
      var recentAEMs = (cml && cml.aiEmotionalMemories || []).slice(0, 3);
      if (recentAEMs.length > 0) {
        var aemText = recentAEMs.map(function(a) { return (a.summary || '').slice(0, 60); }).join(' | ');
        if (aemText) parts.push('【最近情绪记忆】' + aemText);
      }
      var recentUSMs = (cml && cml.userStarredMemories || []).filter(function(u) { return u.summary; }).slice(0, 3);
      if (recentUSMs.length > 0) {
        var usmText = recentUSMs.map(function(u) { return (u.summary || '').slice(0, 60); }).join(' | ');
        if (usmText) parts.push('【最近星标记忆】' + usmText);
      }
      var recentLTMs = (proj && proj.memories || []).filter(function(m) { return m.type === 'long_term'; }).slice(0, 3);
      if (recentLTMs.length > 0) {
        var ltmText = recentLTMs.map(function(m) { return ((m.summary || m.content || '')).slice(0, 60); }).join(' | ');
        if (ltmText) parts.push('【最近长期记忆】' + ltmText);
      }
    }

    // ── 召回性（一次性） ──
    if (hasRecall) {
      parts.push(chat._pendingRetrievalBlock);
      chat._pendingRetrievalBlock = null;
    }

    // ── 实时性（有更新才注入）：阅读 / 最近日记 / 用户可能状态 / 状态(POKE) ──
    var readingBooks = store.books.filter(function(b) { return b.progress > 0 && b.progress < 100; });
    var readingText = '';
    if (readingBooks.length > 0) {
      readingText = '【阅读】' + readingBooks.map(function(b) { return '《' + b.title + '》' + b.progress + '%'; }).join(', ');
    }

    var projectWindowIds = (proj && proj.chats) ? proj.chats.map(function(c) { return c.id; }) : [];
    var diaryLines = [];
    var recentUserDiary = store.diaries.filter(function(d) { return d.author === 'user'; })[0];
    if (recentUserDiary) {
      var dc = recentUserDiary.content;
      diaryLines.push('【用户最近日记】' + (dc.length > 100 ? dc.slice(0, 100) + '…' : dc));
    }
    var recentAIDiary = store.diaries.filter(function(d) {
      return d.author === 'ai' && d.sourceChatId && projectWindowIds.indexOf(d.sourceChatId) >= 0;
    })[0];
    if (recentAIDiary) {
      var dc2 = recentAIDiary.content;
      diaryLines.push('【你的最近日记】' + (dc2.length > 100 ? dc2.slice(0, 100) + '…' : dc2));
    }
    var diaryText = diaryLines.join('\n');

    var userStateText = '';
    if (ais.autoDateTime) {
      var now2 = new Date();
      userStateText = '她现在的可能状态-你可能在想（也可以做你想的）：' + fGetUserPossibleState(now2.getHours(), now2.getDay()) + '。';
    }

    var statusLines = [];
    if (proj && proj._aiStatus) statusLines.push('你的当前状态：' + proj._aiStatus);
    if (proj && proj._userStatus) statusLines.push('她当前的状态：' + proj._userStatus);
    if (proj && proj._userStatusChanged) statusLines.push('她更新了状态，你可以戳一戳');
    var statusText = statusLines.length > 0 ? '【状态】' + statusLines.join(' | ') : '';

    fSnapshotInject(parts, snap, 'reading', readingText, forceSnapshot);
    fSnapshotInject(parts, snap, 'diary', diaryText, forceSnapshot);
    fSnapshotInject(parts, snap, 'userState', userStateText, forceSnapshot);
    fSnapshotInject(parts, snap, 'status', statusText, forceSnapshot);

    var result = parts.join('\n');
    if (!explicitContext) _dynCtxCache = { fp: fp, content: result, ts: nowTs };
    return result;
  }

  function buildRecentMsgIdBlock(chat) {
    if (!chat || !chat.messages) return '';
    var recent = chat.messages.slice(-20);
    var lines = recent
      .filter(function(m) { return m.id && m.role !== 'system'; })
      .map(function(m) {
        var roleLabel = m.role === 'user' ? AppCore.USER_NAME : getAIName();
        var preview = (m.text || '').slice(0, 40).replace(/\n/g, ' ');
        return '[' + m.id + '] ' + roleLabel + ': ' + preview;
      });
    if (lines.length === 0) return '';
    return lines.join('\n');
  }

  function buildSystemPrompt() {
    return SYSTEM_PROMPT_STATIC + '\n\n' + buildDynamicContextBlock();
  }

  function getChatForContext(projectId, chatId) {
    var project = getProjectById(projectId);
    if (!project || !Array.isArray(project.chats)) return null;
    return project.chats.find(function(chat) { return chat.id === chatId; }) || null;
  }

  function formatCodexHistoryMessage(message, chat) {
    if (!message || (message.role !== 'user' && message.role !== 'ai' && message.role !== 'assistant')) return '';
    var role = message.role === 'user' ? '用户' : '暖伴';
    var content = message.text || '';
    if (message.replyTo && message.role === 'user' && chat) {
      var quoted = chat.messages.find(function(item) { return item.id === message.replyTo; });
      if (quoted) content = '[引用' + (quoted.role === 'user' ? AppCore.USER_NAME : '暖伴') + '的消息：「' + (quoted.text || '').slice(0, 150) + '」]\n' + content;
    }
    return role + ': ' + content;
  }

  function groupCodexRounds(messages) {
    if (typeof groupMessagesIntoRounds === 'function') return groupMessagesIntoRounds(messages);
    if (typeof MemoryModule !== 'undefined' && MemoryModule.groupMessagesIntoRounds) return MemoryModule.groupMessagesIntoRounds(messages);
    var rounds = [];
    var current = null;
    (messages || []).forEach(function(message) {
      if (message.role === 'user' || !current) {
        current = { msgs: [] };
        rounds.push(current);
      }
      current.msgs.push(message);
    });
    return rounds;
  }

  function buildCodexPromptContext(options) {
    options = options || {};
    var project = getProjectById(options.projectId);
    var chat = getChatForContext(options.projectId, options.chatId);
    if (!project || !chat) throw new Error('CODEX_CONTEXT_NOT_FOUND');
    var currentIds = {};
    (options.currentMessageIds || []).forEach(function(id) { currentIds[id] = true; });
    var currentMessages = (options.currentMessages || chat.messages.filter(function(message) { return currentIds[message.id]; }));
    var currentLines = currentMessages.map(function(message) { return formatCodexHistoryMessage(message, chat); }).filter(Boolean);
    if (currentLines.length === 0 && options.currentUserText) currentLines.push('用户: ' + options.currentUserText);

    var dynamicSnapshot = Object.assign({}, chat._dynCtxSnapshot || {});
    var dynamicBlock = buildDynamicContextBlock(project, chat, {
      snapshot: dynamicSnapshot,
      forceSnapshot: options.newSession === true
    });
    var customPromptContext = options.customPromptContext || '';
    if (!customPromptContext && options.beginCustomPrompt !== false) {
      var customPromptModule = AppCore.getModule('customPrompts');
      if (customPromptModule && customPromptModule.beginAiRound) {
        var customPromptRound = customPromptModule.beginAiRound(chat);
        customPromptContext = customPromptRound && customPromptRound.content || '';
      }
    }

    var historyMessages = chat.messages.filter(function(message) {
      if (currentIds[message.id]) return false;
      if (message.role !== 'user' && message.role !== 'ai' && message.role !== 'assistant') return false;
      if (message._isHandoffNote || message._searchResult) return false;
      if (message._codexTurnStatus === 'running' || message._codexTurnStatus === 'failed' || message._codexTurnStatus === 'canceled' || message._codexTurnStatus === 'unknown') return false;
      return true;
    });
    var historyLines = [];
    if (!options.continuation) {
      var rounds = groupCodexRounds(historyMessages);
      var l1Rounds = rounds.slice(-6);
      var l2Rounds = rounds.slice(Math.max(0, rounds.length - 30), Math.max(0, rounds.length - 6));
      if (l2Rounds.length > 0 && chat._roundSummaries && chat._roundSummaries.length > 0) {
        var summary = chat._roundSummaries[chat._roundSummaries.length - 1];
        if (summary && summary.summary) historyLines.push('【较早对话摘要】' + summary.summary);
      }
      l1Rounds.forEach(function(round) { (round.msgs || []).forEach(function(message) { var line = formatCodexHistoryMessage(message, chat); if (line) historyLines.push(line); }); });
    }

    var preference = (project.preference || '').trim();
    var sharedDiaryBlock = pendingSharedDiaryContext(chat);
    var sections = [
      'WARM BUDDY APPLICATION CONTEXT',
      '以下内容是应用层上下文和当前回合资料，不替换 Codex CLI 的原生 system prompt。',
      '【系统设定】\n' + SYSTEM_PROMPT_STATIC,
      '【项目偏好】\n' + (preference || '当前无额外项目偏好。'),
      '【动态上下文当前快照】\n' + (dynamicBlock || '当前没有可注入的动态上下文。')
    ];
    if (customPromptContext) sections.push(customPromptContext);
    if (sharedDiaryBlock) sections.push(sharedDiaryBlock);
    if (currentLines.some(function(line) { return line.indexOf('[[FILE:') >= 0; })) {
      sections.push('【附件处理】当前消息中的 [[FILE:id]] 仅是应用 artifact 引用；本阶段不向 Codex 发送二进制或 Data URL，不能据此声称已经读取文件。');
    }
    if (historyLines.length > 0) sections.push('【历史对话（沿用现有 L1/L2 规则）】\n' + historyLines.join('\n'));
    else if (options.continuation) sections.push('【历史对话】Gateway session 已保留历史，本次不重复灌入完整历史。');
    sections.push('【当前用户消息（本轮只出现一次）】\n' + (currentLines.join('\n') || '用户: ' + (options.currentUserText || '')));
    return {
      prompt: sections.join('\n\n'),
      customPromptContext: customPromptContext,
      currentMessageIds: Object.keys(currentIds),
      commitDynamicContextSnapshot: function() {
        chat._dynCtxSnapshot = Object.assign({}, dynamicSnapshot);
      }
    };
  }

  function invalidateDynamicContext() {
    _dynCtxCache = { fp: '', content: '', ts: 0 };
  }

  // ======================================================================
  //  Block 9: renderChatMessages, reply blocks, scroll, batch select, star
  // ======================================================================
  // ═══════════════════════════════════════════
  //  Sanitize
  // ═══════════════════════════════════════════
  function sanitizeDisplayText(text) {
    if (!text) return text;
    text = text.replace(/<!--\s*REFLECT\s*\{[\s\S]*?\}\}/gi, '');
    text = text.replace(/<!--\s*REFLECT[\s\S]*$/gi, '');
    text = text.replace(/<!--\s*(?:REFLECT|DIARY|MEMORY|STAR|LTM|LITTER)[\s\S]*?-->/gi, '');
    // Strip [[XXX:...]] markers but KEEP [[FILE:...]] for resolveArtifactRefs
    text = text.replace(/\[\[(?!FILE:)\w+:[\s\S]*?\]\]/g, '');
    text = text.replace(/^(MESSAGE|LITTER|DIARY|EMAIL|TODO):\s*/gmi, '');
    text = AppCore.escapeHtml(text);
    return text;
  }

  function sanitizeProactiveMessage(content) {
    if (!content) return '';
    return content
      .replace(/\[\[\w+:[\s\S]*?\]\]/g, '')
      .replace(/^(MESSAGE|LITTER|DIARY|EMAIL|TODO):\s*/gmi, '')
      .trim();
  }

  // ═══════════════════════════════════════════
  //  Tool call panel rendering
  // ═══════════════════════════════════════════

  function renderToolCallPanel(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return '';
    var msgId = AppCore.generateMsgId(); // unique id for this panel instance
    var html = '<div class="tool-call-panel">';
    html += '<div class="tool-call-header" data-action="toggleToolCallPanel" data-args="' + msgId + '">';
    html += '<span class="tool-call-arrow" id="tcArrow_' + msgId + '">▼</span>';
    html += '<span>工具调用 <span class="tool-call-count">(' + toolCalls.length + ')</span></span>';
    html += '</div>';
    html += '<div class="tool-call-items" id="tcItems_' + msgId + '">';
    for (var i = 0; i < toolCalls.length; i++) {
      var tc = toolCalls[i];
      var fnName = tc.name || 'unknown';
      html += '<div class="tool-call-item" data-action="showToolCallDetail" data-args="' + msgId + '|' + i + '">';
      html += '<span class="tool-call-item-icon">&#x238C;</span>';
      html += '<div class="tool-call-item-body">';
      html += '<div class="tool-call-item-label">调用工具</div>';
      html += '<div class="tool-call-item-name">' + AppCore.escapeHtml(fnName) + '</div>';
      html += '</div>';
      html += '<span class="tool-call-item-arrow">›</span>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    // Store toolCalls reference for detail lookup
    _toolCallPanelStore[msgId] = toolCalls;
    return html;
  }

  var _toolCallPanelStore = {};

  function toggleToolCallPanel(panelId) {
    var items = AppCore.$('tcItems_' + panelId);
    var arrow = AppCore.$('tcArrow_' + panelId);
    if (!items) return;
    if (items.style.display === 'none') {
      items.style.display = 'block';
      if (arrow) arrow.textContent = '▼';
    } else {
      items.style.display = 'none';
      if (arrow) arrow.textContent = '▶';
    }
  }

  function showToolCallDetail(panelId, idx) {
    var toolCalls = _toolCallPanelStore[panelId];
    if (!toolCalls || !toolCalls[idx]) return;
    var tc = toolCalls[idx];
    var fnName = tc.name || 'unknown';
    var argsStr = '';
    try { argsStr = JSON.stringify(tc.args, null, 2); } catch (e) { argsStr = String(tc.args || ''); }
    var resultStr = tc.result || '(无返回内容)';
    UIModule.showModal(fnName,
      '<div class="tool-call-detail-section">' +
        '<div class="tool-call-detail-label">参数</div>' +
        '<pre class="tool-call-detail-pre">' + AppCore.escapeHtml(argsStr) + '</pre>' +
      '</div>' +
      '<div class="tool-call-detail-section">' +
        '<div class="tool-call-detail-label">返回结果</div>' +
        '<pre class="tool-call-detail-pre">' + AppCore.escapeHtml(resultStr) + '</pre>' +
      '</div>',
      [{ label: 'close', cls: 'cancel', onclick: UIModule.closeModal }]);
  }

  // ═══════════════════════════════════════════
  //  Chat message rendering
  // ═══════════════════════════════════════════
  function renderChatMessages(preserveScroll) {
    _toolCallPanelStore = {};
    var store = AppCore.getStore();
    var el = AppCore.$('chatMessages'), chat = getActiveChatObj();
    var savedScrollTop = preserveScroll && el ? el.scrollTop : 0;
    var proj = getActiveProject();
    ensureSharedDiaryCards(chat);
    var todayIso = AppCore.fmtDate().iso;
    var chatTime = (typeof ChatTimeModule !== 'undefined' && ChatTimeModule) ||
      (AppCore.getModule && AppCore.getModule('chatTime'));
    if (!chat || chat.messages.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:40px 20px;"><span style="font-family:var(--font-en);font-size:12px;color:var(--text-lighter);">— start a conversation —</span></div>';
      return;
    }
    el.classList.toggle('batch-select-mode', batchSelectMode);

    var html = '';
    var shownDate = '';
    var previousTimeInfo = null;
    var visibleMessages = chat.messages.map(function(message, index) {
      return { message: message, index: index };
    }).filter(function(entry) {
      return entry.message.contentType !== 'dateDivider';
    });
    visibleMessages.forEach(function(entry) {
      var m = entry.message;
      var i = entry.index;
      var timeInfo = chatTime && chatTime.getTimeInfo ? chatTime.getTimeInfo(m) : null;
      var msgDate = timeInfo ? timeInfo.date : '';
      if (msgDate && msgDate !== shownDate) {
        var d = new Date(msgDate + 'T00:00:00');
        var weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        var weekday = isNaN(d.getTime()) ? '' : weekdays[d.getDay()];
        html += '<div class="chat-date-separator">📅 ' + msgDate + ' ' + weekday + '</div>';
        shownDate = msgDate;
      }
      if (previousTimeInfo && timeInfo && timeInfo.sortValue - previousTimeInfo.sortValue >= 5 * 60 * 1000) {
        html += '<div class="chat-gap-separator"></div>';
      }
      if (timeInfo) previousTimeInfo = timeInfo;
      var displayTime = timeInfo ? timeInfo.time : (m.time || '');
      var bubbleTime = timeInfo && timeInfo.date !== todayIso ? timeInfo.date.slice(5) + ' ' + timeInfo.time : displayTime;
      if (m.role === 'system') {
        html += '<div class="chat-system-msg">' +
          '<span class="chat-system-msg-text">' + m.text + '</span>' +
          (displayTime ? '<span class="chat-system-msg-time">' + displayTime + '</span>' : '') +
        '</div>';
        return;
      }
      if (!m.id) m.id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      var msgId = m.id;
      var isUser = m.role === 'user';
      if (m.contentType === 'shared_diary') {
        var sd = m.sharedDiary || {};
        var sdRole = diaryChatRole(sd);
        var sdIsUser = sdRole === 'user';
        var sdAuthor = diaryAuthorName(sd);
        var sdHtml = '<div class="shared-diary-card" onclick="event.stopPropagation();openSharedDiary(\'' + sd.id + '\')">' +
          '<div class="shared-diary-card-title">' + AppCore.escapeHtml(sd.title || '未命名') + '</div>' +
          '<div class="shared-diary-card-meta">' + AppCore.escapeHtml((sd.date || '') + ' ' + (sd.time || '')) + ' · ' + AppCore.escapeHtml(sdAuthor) + '</div></div>';
        html += '<div class="chat-row ' + sdRole + '" id="msg-' + msgId + '"><div class="chat-avatar ' + sdRole + '">' + (sdIsUser ? 'MY' : '✦') + '</div><div class="chat-bubble-wrap"><div class="chat-bubble ' + sdRole + ' shared-diary-bubble">' + sdHtml + '</div><div class="bubble-time-row"><span class="bubble-time">' + AppCore.escapeHtml(bubbleTime) + '</span></div></div></div>';
        return;
      }
      var isSelected = batchSelectMode && batchSelectedIds.indexOf(msgId) >= 0;
      var bubbleCls = 'chat-bubble ' + m.role;
      if (isSelected) bubbleCls += ' batch-selected';

      var starOnceCls = m._starredOnce ? 'starred-once' : '';
      var starSelectedCls = isSelected ? 'batch-selected-star' : '';
      var starIcon = m._starredOnce ? '★' : '☆';
      var starTitle = m._starredOnce ? '已星标' : '点击选中星标';
      var starAction = m._starredOnce ? '' : "handleOuterStarClick('" + msgId + "')";

      // Plan B: extract artifact cards at render time (before escapeHtml)
      var displayText = m.text || '';
      var artifactCards = [];
      try {
        if (displayText.indexOf('<!--ARTIFACT_START:') >= 0 || displayText.indexOf('artifact-card-inline') >= 0) {
          var art = AppCore.getModule('artifacts');
          if (art && art.extractFromText) {
            var artResult = art.extractFromText(displayText);
            displayText = artResult.text;
            artifactCards = artResult.cards;
          }
        }
        displayText = sanitizeDisplayText(displayText);
        // Restore artifact card HTML (safe, pre-built — bypassed escapeHtml via placeholders)
        for (var ci = 0; ci < artifactCards.length; ci++) {
          displayText = displayText.replace(artifactCards[ci].placeholder, artifactCards[ci].cardHtml);
        }
        displayText = resolveArtifactRefs(displayText);
      } catch (e) {
        // Per-message fault tolerance: a broken message must never abort the whole list.
        console.error('[render] 第', i, '条消息渲染失败，已降级为纯文本:', e && e.message, 'role=', m.role);
        displayText = AppCore.escapeHtml(m.text || '');
      }
      var codexStatusHtml = '';
      if (m._codexRuntime === 'codex-gateway' && m._codexTurnStatus && m._codexTurnStatus !== 'completed') {
        var codexStatusLabels = { running: 'Codex 生成中', failed: 'Codex 失败', canceled: 'Codex 已停止', unknown: 'Codex 结果未知' };
        codexStatusHtml = '<span class="codex-turn-status">' + (codexStatusLabels[m._codexTurnStatus] || 'Codex 状态未知') + '</span>';
      }

      html += '<div class="chat-row ' + m.role + '" id="msg-' + msgId + '">' +
        '<div class="chat-avatar ' + m.role + ('' + (!isUser && proj && proj._aiStatusChanged ? ' status-changed' : '')) + '" ' + (isUser ? '' : 'ondblclick="handleAIAvatarDblClick()" title="双击戳一戳"') + ' style="' + (isUser ? '' : 'cursor:pointer;') + '">' + (isUser ? 'MY' : '✦') + '</div>' +
        '<div class="chat-bubble-wrap">' +
          (!isUser && m._toolCalls && m._toolCalls.length > 0 ? renderToolCallPanel(m._toolCalls) : '') +
          '<div class="' + bubbleCls + '"' +
               ' onclick="handleBubbleClick(event,\'' + msgId + '\',\'' + i + '\')"' +
               ' oncontextmenu="event.preventDefault();handleBubbleLongPress(\'' + msgId + '\')"' +
               ' ontouchstart="bubbleTouchStart(event,\'' + msgId + '\')"' +
               ' ontouchend="bubbleTouchEnd(event,\'' + msgId + '\')"' +
               ' ontouchmove="bubbleTouchMove(event)">' +
            (m.replyTo ? renderReplyBlock(m.replyTo) : '') + displayText + codexStatusHtml +
          '</div>' +
          '<div class="bubble-time-row">' +
          (isUser ?
          '<span class="outer-star-icon ' + starOnceCls + ' ' + starSelectedCls + '"' +
                ' onclick="event.stopPropagation();' + starAction + '"' +
                ' ontouchstart="event.stopPropagation();"' +
                ' ontouchend="event.stopPropagation();"' +
                ' title="' + starTitle + '">' + starIcon + '</span>' +
          '<span class="bubble-time">' + AppCore.escapeHtml(bubbleTime) + '</span>'
          :
          '<span class="bubble-time">' + AppCore.escapeHtml(bubbleTime) + '</span>' +
          (m._proactive ? '<span class="bubble-source-label">' + (m._todoWake ? '自我唤醒' : (m._desireType ? getDriveLabel(m._desireType) : '')) + '</span>' : '') +
          '<span class="outer-star-icon ' + starOnceCls + ' ' + starSelectedCls + '"' +
                ' onclick="event.stopPropagation();' + starAction + '"' +
                ' ontouchstart="event.stopPropagation();"' +
                ' ontouchend="event.stopPropagation();"' +
                ' title="' + starTitle + '">' + starIcon + '</span>'
          ) +
          '</div>' +
        '</div>' +
      '</div>';
      html += '<div id="bubbleActions_' + i + '" class="bubble-actions" style="display:none;justify-content:' + (isUser ? 'flex-end' : 'flex-start') + ';padding-left:' + (isUser ? '0' : '38px') + ';padding-right:' + (isUser ? '38px' : '0') + ';">' +
        '<span onclick="event.stopPropagation();playTTS(' + i + ')" title="语音朗读">🔊</span>' +
        '<span onclick="event.stopPropagation();copyBubble(' + i + ')" title="复制">📋</span>' +
        '<span onclick="event.stopPropagation();startReply(\'' + msgId + '\')" title="引用">↩</span>' +
        '<span onclick="event.stopPropagation();deleteBubble(' + i + ')" title="删除">🗑</span>' +
      '</div>';
    });
    el.innerHTML = html;
    if (preserveScroll) { el.scrollTop = savedScrollTop; }
    else { el.scrollTop = el.scrollHeight; }

    var bar = AppCore.$('batchSelectBar');
    if (bar) {
      if (batchSelectMode) {
        bar.classList.add('show');
        AppCore.$('batchSelectCount').textContent = '已选 ' + batchSelectedIds.length + ' 条';
      } else {
        bar.classList.remove('show');
      }
    }
  }

  function renderReplyBlock(replyToMsgId) {
    if (!replyToMsgId) return '';
    var chat = getActiveChatObj();
    if (!chat) return '';
    var quoted = chat.messages.find(function(m) { return m.id === replyToMsgId; });
    if (!quoted) return '';
    var label = quoted.role === 'user' ? AppCore.USER_NAME : getAIName();
    var preview = (quoted.text || '').slice(0, 80);
    return '<div class="quote-block" onclick="event.stopPropagation();scrollToMsg(\'' + replyToMsgId + '\')"><div class="quote-block-label">' + AppCore.escapeHtml(label) + '</div><div class="quote-block-text">' + AppCore.escapeHtml(preview) + '</div></div>';
  }

  function scrollToMsg(msgId) {
    var el = document.getElementById('msg-' + msgId);
    if (!el) return;
    document.querySelectorAll('.msg-highlight').forEach(function(e) { e.classList.remove('msg-highlight'); });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('msg-highlight');
    setTimeout(function() { el.classList.remove('msg-highlight'); }, 1300);
  }

  function startReply(msgId) {
    var chat = getActiveChatObj();
    if (!chat) return;
    var msg = chat.messages.find(function(m) { return m.id === msgId; });
    if (!msg || msg.role === 'system') return;
    pendingReply = {
      msgId: msg.id,
      text: (msg.text || '').slice(0, 120),
      label: msg.role === 'user' ? AppCore.USER_NAME : getAIName(),
      role: msg.role
    };
    document.querySelectorAll('.bubble-actions').forEach(function(a) { a.style.display = 'none'; });
    renderReplyPreview();
    AppCore.$('chatInput').focus();
  }

  function cancelReply() {
    pendingReply = null;
    renderReplyPreview();
  }

  function renderReplyPreview() {
    var bar = AppCore.$('replyPreviewBar');
    if (!pendingReply) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    AppCore.$('replyPreviewLabel').textContent = pendingReply.label;
    AppCore.$('replyPreviewText').textContent = pendingReply.text;
  }

  function bubbleTouchStart(e, msgId) {
    if (batchSelectMode) return;
    bubbleTouchMsgId = msgId;
    bubbleTouchTimer = setTimeout(function() {
      bubbleTouchTimer = null;
      handleBubbleLongPress(msgId);
    }, 500);
  }

  function bubbleTouchEnd(e, msgId) {
    if (bubbleTouchTimer) {
      clearTimeout(bubbleTouchTimer);
      bubbleTouchTimer = null;
    }
  }

  function bubbleTouchMove(e) {
    if (bubbleTouchTimer) {
      clearTimeout(bubbleTouchTimer);
      bubbleTouchTimer = null;
    }
  }

  function handleBubbleClick(event, msgId, idx) {
    if (batchSelectMode) {
      toggleBatchSelect(msgId);
    } else {
      toggleBubbleActions(event, idx);
    }
  }

  function handleBubbleLongPress(msgId) {
    if (batchSelectMode) return;
    var chat = getActiveChatObj();
    if (!chat) return;
    var msg = chat.messages.find(function(m) { return m.id === msgId; });
    if (!msg) return;
    enterBatchSelectMode(msgId);
  }

  function handleOuterStarClick(msgId) {
    var chat = getActiveChatObj();
    if (!chat) return;
    var msg = chat.messages.find(function(m) { return m.id === msgId; });
    if (!msg || msg._starredOnce) return;
    if (!batchSelectMode) {
      enterBatchSelectMode(msgId);
    } else {
      toggleBatchSelect(msgId);
    }
  }

  function enterBatchSelectMode(initMsgId) {
    batchSelectMode = true;
    batchSelectedIds = [initMsgId];
    renderChatMessages(true);
  }

  function toggleBatchSelect(msgId) {
    var chat = getActiveChatObj();
    if (!chat) return;
    var msg = chat.messages.find(function(m) { return m.id === msgId; });
    if (!msg) return;
    var idx = batchSelectedIds.indexOf(msgId);
    if (idx >= 0) {
      batchSelectedIds.splice(idx, 1);
    } else {
      batchSelectedIds.push(msgId);
    }
    if (batchSelectedIds.length === 0) {
      exitBatchSelectMode();
      return;
    }
    renderChatMessages(true);
  }

  function exitBatchSelectMode() {
    batchSelectMode = false;
    batchSelectedIds = [];
    renderChatMessages(true);
  }

  async function confirmBatchStar() {
    var store = AppCore.getStore();
    var chat = getActiveChatObj();
    if (!chat) return;

    var allSelected = batchSelectedIds
      .map(function(id) { return chat.messages.find(function(m) { return m.id === id; }); })
      .filter(Boolean);
    var newMsgs = allSelected.filter(function(m) { return !m._starredOnce; });
    var alreadyStarredCount = allSelected.length - newMsgs.length;

    if (newMsgs.length === 0) {
      exitBatchSelectMode();
      UIModule.toast('所选消息均已星标过');
      return;
    }

    var previewTexts = newMsgs.slice(0, 3).map(function(m) {
      return (m.role === 'user' ? '用户' : 'AI') + ': ' + (m.text || '').slice(0, 40) + ((m.text || '').length > 40 ? '…' : '');
    });
    var preview = previewTexts.join('<br>') + (newMsgs.length > 3 ? '<br><span style="font-size:11px;color:var(--text-lighter);">等' + newMsgs.length + '条</span>' : '');
    var note = alreadyStarredCount > 0 ? '<div style="font-size:11px;color:var(--text-lighter);margin-bottom:8px;">（已跳过 ' + alreadyStarredCount + ' 条已星标消息）</div>' : '';

    var newMsgIds = newMsgs.map(function(m) { return m.id; });

    UIModule.showModal('存为星标记忆',
      note +
      '<div style="font-size:12px;color:var(--text-light);margin-bottom:8px;">将保存 ' + newMsgs.length + ' 条新消息：</div>' +
      '<div style="font-size:12px;color:var(--text);line-height:1.5;margin-bottom:12px;padding:8px;background:var(--bg);border-radius:8px;">' + preview + '</div>' +
      '<input type="hidden" id="batchStarMsgIds" value="' + JSON.stringify(newMsgIds).replace(/"/g, '&quot;') + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'confirm', cls: 'confirm', onclick: executeBatchStar }]);
  }

  async function executeBatchStar() {
    var store = AppCore.getStore();
    store._importing = true; UIModule.closeModal();
    var idsStr = AppCore.$('batchStarMsgIds').value;
    var selectedMsgIds;
    try { selectedMsgIds = JSON.parse(idsStr.replace(/&quot;/g, '"')); } catch (e) { exitBatchSelectMode(); return; }
    await createUserStarredMemory(selectedMsgIds);
    exitBatchSelectMode();
  }

  async function createUserStarredMemory(selectedMsgIds) {
    var store = AppCore.getStore();
    var chat = getActiveChatObj();
    var proj = getActiveProject();
    if (!chat || !proj) return;

    var msgs = selectedMsgIds.map(function(id) { return chat.messages.find(function(m) { return m.id === id; }); }).filter(Boolean);
    if (msgs.length === 0) return;

    var rawDialogue = msgs.map(function(m) {
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        text: m.text || '',
        time: m.time || '',
        msgId: m.id || ''
      };
    });

    msgs.forEach(function(m) { m._starredOnce = true; m._starred = true; });

    // Create USM placeholder immediately — summary filled in by the async LLM call below
    var usmId = 'usm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    var usm = {
      id: usmId,
      timestamp: new Date().toISOString(),
      sourceChatId: store.activeChat,
      sourceWindowId: store.activeChat,
      sourceProjectId: store.activeProject,
      rawDialogue: rawDialogue,
      summary: '',
      starred: true,
      decayFactor: 1,
      starredMsgIds: selectedMsgIds,
      userNote: ''
    };
    MemoryModule.addUSM(store.activeProject, usm);
    checkDeriveInsightsTrigger('usm');
    AppCore.saveStore();

    // Fire standalone LLM call with identity context (Core overview + recent rounds + recent USMs/AEMs)
    MemoryModule.generateUSM(usmId, rawDialogue).catch(function(e) {
      console.log('[USM] Background generation failed:', e.message);
    });
  }

  // ═══════════════════════════════════════════
  //  Self-reflection (extracted from index.html)
  // ═══════════════════════════════════════════
  function extractReflection(responseText) {
    var match = responseText.match(/<!--\s*REFLECT\s*([\s\S]*?)\s*-->/i);
    if (!match) {
      var fbMatch = responseText.match(/<!--\s*REFLECT\s*\{([\s\S]*?)\}\}/i);
      if (fbMatch) {
        match = fbMatch;
        match[1] = '{' + fbMatch[1] + '}';
      }
    }
    if (!match) return { cleanText: responseText, reflection: null };
    var inner = match[1].trim();
    var cleanText = (responseText.slice(0, match.index) + responseText.slice(match.index + match[0].length)).trim();
    if (inner.startsWith('{')) {
      try {
        var reflection = JSON.parse(inner);
        if (reflection.ai_affect_label && reflection.user_affect_label) {
          return { cleanText: cleanText, reflection: reflection };
        }
      } catch(e) {}
    }
    var compactRe = /^([^,]+),\s*(\d+)\s*,\s*([^,]+),\s*(\d+)\s*,\s*(.+)$/;
    var cm = inner.match(compactRe);
    if (cm) {
      var aiLabel = cm[1].trim().replace(/^\{/, '');
      var userLabel = cm[3].trim().replace(/^\{/, '');
      return {
        cleanText: cleanText,
        reflection: {
          ai_affect_label: aiLabel,
          ai_affect_intensity: parseInt(cm[2]) || 5,
          user_affect_label: userLabel,
          user_affect_intensity: parseInt(cm[4]) || 5,
          signal_source: cm[5].trim()
        }
      };
    }
    var fallback = parseReflectionFallback(inner);
    if (fallback) return { cleanText: cleanText, reflection: fallback };
    return { cleanText: responseText, reflection: null };
  }

  function parseReflectionFallback(text) {
    try {
      var getInt = function(key) { var m = text.match(new RegExp('"' + key + '"\\s*:\\s*(\\d+)')); return m ? parseInt(m[1]) : 5; };
      var getStr = function(key) { var m = text.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"')); return m ? m[1] : '平静在场'; };
      return {
        ai_affect_label: getStr('ai_affect_label'),
        ai_affect_intensity: getInt('ai_affect_intensity'),
        user_affect_label: getStr('user_affect_label'),
        user_affect_intensity: getInt('user_affect_intensity'),
        signal_source: getStr('signal_source')
      };
    } catch(e) { return null; }
  }

  function extractMemoryMarker(text) {
    if (!text) return null;
    var jsonRe = /<!--\s*MEMORY\s*(\{[\s\S]*?\})\s*-->/;
    var jm = text.match(jsonRe);
    if (jm) {
      try {
        var parsed = JSON.parse(jm[1]);
        if (parsed.summary) return { summary: parsed.summary.slice(0, 100), internalNote: (parsed.note || parsed.internalNote || '').slice(0, 200), keywords: (parsed.keywords || []).map(String).slice(0, 5) };
      } catch(e) {}
    }
    var pipeRe = /<!--\s*MEMORY\s*\{([^|}]*)\|([\s\S]*?)\}\s*-->/;
    var pm = text.match(pipeRe);
    if (!pm) return null;
    console.warn('[memory] Legacy pipe-format MEMORY marker detected, consider updating prompt');
    return { summary: pm[1].trim().slice(0, 100), internalNote: pm[2].trim().slice(0, 200) };
  }

  function extractTodosFromResponse(text) {
    if (!text) return [];
    var re = /\[\[TODO:([^\]|]+)\|(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)\]\]/g;
    var todos = [];
    var match;
    while ((match = re.exec(text)) !== null) {
      var title = match[1].trim();
      var deadline = (match[2] || '').trim();
      if (title) todos.push({ title: title, deadline: deadline });
    }
    return todos;
  }

  function processReflection(reflection, userMsg, aiResponse, chat) {
    if (!reflection) return;
    var store = AppCore.getStore();
    var ms = store.memorySystem;
    ms.reflections.unshift({
      timestamp: new Date().toISOString(),
      ai_affect_label: reflection.ai_affect_label,
      ai_affect_intensity: reflection.ai_affect_intensity,
      user_affect_label: reflection.user_affect_label,
      user_affect_intensity: reflection.user_affect_intensity,
      signal_source: reflection.signal_source,
      sourceChatId: store.activeChat
    });
    if (ms.reflections.length > ms.reflectionMax) {
      ms.reflections.length = ms.reflectionMax;
    }
    updateAffectGraph(reflection.ai_affect_label, reflection.user_affect_label);
    var aiIntensity = reflection.ai_affect_intensity || 0;
    var userIntensity = reflection.user_affect_intensity || 0;
    if (aiIntensity >= 7 || userIntensity >= 7) {
      var memMarker = extractMemoryMarker(aiResponse);
      console.log('[AEM-debug] intensity high (ai=' + aiIntensity + ', user=' + userIntensity + '), MEMORY marker found:', !!memMarker, memMarker ? memMarker.summary?.slice(0,40) : 'NONE');
      if (memMarker && memMarker.summary) {
        if (typeof createAEMFromMarkers === 'function') {
          createAEMFromMarkers(reflection, userMsg, aiResponse, chat, memMarker);
          console.log('[AEM-debug] AEM created via createAEMFromMarkers, total AEMs:', (MemoryModule.getCML(AppCore.getStore().activeProject)?.aiEmotionalMemories||[]).length);
        } else {
          console.log('[AEM-debug] createAEMFromMarkers not available');
        }
      } else {
        console.log('[AEM-debug] No MEMORY marker in response (intensity was high but LLM did not include marker)');
      }
    }
    if (chat) {
      chat._messageCount = (chat._messageCount || 0) + 1;
    }
    if (typeof updateDesireDrives === 'function') updateDesireDrives(reflection);
  }

  // Codex completion actions are deliberately separate from the legacy Claude
  // response parser.  They run once, only after the whole Codex turn succeeds,
  // and always resolve the original project/chat rather than the active view.
  async function commitCodexResponse(options) {
    options = options || {};
    var project = getProjectById(options.projectId);
    var chat = getChatForContext(options.projectId, options.chatId);
    if (!project || !chat || !options.turnId) throw new Error('CODEX_CONTEXT_NOT_FOUND');
    if (chat._codexGeneration !== undefined && chat._codexGeneration !== options.generation) return false;
    if (!chat._codexActionKeys) chat._codexActionKeys = {};
    var actionKeys = chat._codexActionKeys;
    if (!chat._codexActionResults) chat._codexActionResults = {};
    var actionResults = chat._codexActionResults;
    var didWork = false;
    var didAction = false;
    function isCurrent() {
      return !options.isCurrent || options.isCurrent();
    }
    function runAction(key, fn) {
      if (!isCurrent() || actionKeys[key]) return false;
      var result = fn();
      var status = result === false ? 'not_executed' : (result && result.status) || 'succeeded';
      actionKeys[key] = status;
      actionResults[key] = status;
      if (status === 'succeeded') didAction = true;
      return status === 'succeeded';
    }
    var store = AppCore.getStore();
    var userMessage = (options.userMessageIds || []).map(function(id) {
      return chat.messages.find(function(message) { return message.id === id; });
    }).filter(Boolean).map(function(message) { return message.text || ''; }).join('\n');
    var finalMessages = options.assistantMessages || chat.messages.filter(function(message) {
      return message._codexTurnId === options.turnId && message.role === 'ai' && message._codexTurnStatus === 'completed';
    });
    var projectName = project.name || '';
    var chatName = chat.name || '';
    for (var i = 0; i < finalMessages.length; i++) {
      var message = finalMessages[i];
      if (message._codexTurnStatus !== 'completed') continue;
      if (message._codexActionCommitted) continue;
      if (!isCurrent()) return false;
      didWork = true;
      var raw = String(message.text || '');
      var reflectionResult = extractReflection(raw);
      var display = reflectionResult.cleanText || raw;
      if (reflectionResult.reflection) {
        var reflection = reflectionResult.reflection;
        runAction('reflection:' + message.id, function() {
          if (!store.memorySystem) store.memorySystem = { reflections: [], reflectionMax: 50, affectGraph: { edges: {} } };
          if (!Array.isArray(store.memorySystem.reflections)) store.memorySystem.reflections = [];
          store.memorySystem.reflections.unshift({
            timestamp: new Date().toISOString(),
            ai_affect_label: reflection.ai_affect_label,
            ai_affect_intensity: reflection.ai_affect_intensity,
            user_affect_label: reflection.user_affect_label,
            user_affect_intensity: reflection.user_affect_intensity,
            signal_source: reflection.signal_source,
            sourceProjectId: options.projectId,
            sourceChatId: options.chatId
          });
          store.memorySystem.reflections.splice(store.memorySystem.reflectionMax || 50);
          updateAffectGraph(reflection.ai_affect_label, reflection.user_affect_label);
          var memMarker = extractMemoryMarker(raw);
          if (memMarker && (reflection.ai_affect_intensity >= 7 || reflection.user_affect_intensity >= 7) && typeof MemoryModule !== 'undefined' && MemoryModule.createAEMFromMarkers) {
            MemoryModule.createAEMFromMarkers(reflection, userMessage, display, chat, memMarker, { projectId: options.projectId, chatId: options.chatId });
          }
          if (typeof updateDesireDrives === 'function' && AppCore.getStore().activeProject === options.projectId) updateDesireDrives(reflection);
        });
      }
      display = display.replace(/\[\[SEARCH:[^\]]+\]\]/gi, '').trim();

      var diaryStructured = display.match(/\[\[DIARY:([^\]|]*)\|([^\]|]*)\|([\s\S]*?)\]\]/i);
      if (diaryStructured && diaryStructured[3].trim()) {
        runAction('diary:' + message.id + ':' + diaryStructured[0], function() {
          var diaryNow = new Date();
          var diaryEntry = {
            id: 'd' + (AppCore.gid ? AppCore.gid('') : Date.now().toString(36)),
            date: AppCore.fmtDate().iso,
            time: AppCore.nowTime(),
            title: diaryStructured[1].trim().slice(0, 15) || diaryStructured[3].trim().slice(0, 15),
            content: diaryStructured[3].trim(), mood: diaryStructured[2].trim() || 'calm', author: 'ai', replies: [],
            sourceChatId: options.chatId, sourceProjectId: options.projectId,
            sourceWindow: projectName + ' / ' + chatName, visibilityMode: 'selected', visibleChatIds: [options.chatId],
            createdAt: diaryNow.toISOString(), _syncPending: true
          };
          store.diaries.unshift(diaryEntry);
          var diaryModule = AppCore.getModule('diary');
          if (diaryModule && diaryModule.addDelivery) diaryModule.addDelivery(diaryEntry.id, options.projectId, options.chatId, 'visibility');
          if (diaryModule && diaryModule.syncEntry) diaryModule.syncEntry(diaryEntry);
        });
        display = display.replace(diaryStructured[0], '').trim();
      }
      display = display.replace(/<!--\s*\/?DIARY:?\w*\s*-->[\s\S]*?<!--\s*\/DIARY\s*-->/gi, '').trim();

      var litterMatch = display.match(/<!--\s*LITTER(?::([^>]*?))?\s*-->([\s\S]*?)<!--\s*\/LITTER\s*-->/i);
      if (litterMatch) {
        runAction('litter:' + message.id + ':' + litterMatch[0], function() {
          var litterModule = AppCore.getModule('litterbox');
          if (!litterModule || !litterModule.ingestFromMainChat) return false;
          litterModule.ingestFromMainChat(litterMatch[2].trim(), (litterMatch[1] || '').trim(), chat, { projectId: options.projectId, chatId: options.chatId });
        });
        display = display.replace(litterMatch[0], '').trim();
      }

      var core = display.match(/\[\[CORE_OVERVIEW:([\s\S]*?)\]\]/i);
      if (core) {
        runAction('core:' + message.id + ':' + core[0], function() {
          var memoryModule = AppCore.getModule('memory');
          if (!memoryModule || !memoryModule.setCoreOverviewLocal) return false;
          memoryModule.setCoreOverviewLocal(core[1].trim().slice(0, 500), project.aiName || 'warmbuddy', options.projectId);
        });
        display = display.replace(core[0], '').trim();
      }

      var todos = extractTodosFromResponse(display);
      if (todos.length) {
        for (var t = 0; t < Math.min(todos.length, 2); t++) {
          (function(todo, todoIndex) {
            runAction('todo:' + message.id + ':' + todoIndex + ':' + todo.title, function() {
              if (!store.todos.some(function(item) { return String(item.text || '').toLowerCase() === todo.title.toLowerCase() && item.projectId === options.projectId; })) {
                store.todos.unshift({ id: 't' + AppCore.gid(''), text: todo.title, done: false, time: todo.deadline, type: 'short', creator: 'ai', chatId: options.chatId, projectId: options.projectId });
              }
            });
          })(todos[t], t);
        }
        display = display.replace(/\[\[TODO:[^\]]+\]\]/g, '').trim();
        var syncModule = AppCore.getModule('sync');
        if (syncModule && syncModule.syncTodosToBackend) syncModule.syncTodosToBackend(options.projectId);
      }
      display = display.replace(/<!--\s*MEMORY\s*\{[\s\S]*?\}\s*-->/gi, '').trim();

      var emailMatch = display.match(/\[\[EMAIL:([^\]|]+)(?:\|([\s\S]*?))?\]\]/i);
      if (emailMatch) {
        var emailKey = 'email:' + message.id + ':' + emailMatch[0];
        if (isCurrent() && !actionKeys[emailKey]) {
          var emailResult = { status: 'not_executed' };
          if (typeof handleEmailSend === 'function') {
            try {
              emailResult = await handleEmailSend(chat, emailMatch[1].trim(), (emailMatch[2] || '').trim(), {
                runtime: 'codex-gateway', projectId: options.projectId, chatId: options.chatId,
                turnId: options.turnId, generation: options.generation, isCurrent: isCurrent
              });
            } catch (_) {
              emailResult = { status: 'unknown' };
            }
          }
          if (!isCurrent()) return false;
          var emailStatus = emailResult === true ? 'succeeded'
            : emailResult === false ? 'failed'
            : (emailResult && (emailResult.status === 'succeeded' || emailResult.status === 'failed' || emailResult.status === 'not_executed' || emailResult.status === 'unknown')
              ? emailResult.status : 'unknown');
          actionKeys[emailKey] = emailStatus;
          actionResults[emailKey] = emailStatus;
          if (emailStatus === 'succeeded') didAction = true;
          else if (typeof UIModule !== 'undefined' && UIModule.toast) UIModule.toast(emailStatus === 'not_executed' ? 'Codex 邮件动作未执行。' : 'Codex 邮件动作未确认成功。');
        }
        display = display.replace(emailMatch[0], '').trim();
      }

      var poke = display.match(/\[\[POKE(?:\:[^\]]*)?\]\]/i);
      if (poke) {
        if (runAction('poke:' + message.id + ':' + poke[0], function() {
          chat.messages.push({ id: AppCore.generateMsgId(), role: 'system', contentType: 'poke_notification', text: '暖伴戳了戳 mays。', _codexTurnId: options.turnId, _codexTurnStatus: 'completed' });
        })) display = display.replace(poke[0], '').trim();
        else display = display.replace(poke[0], '').trim();
      }
      var status = display.match(/\[\[STATUS:([^\]]+)\]\]/i);
      if (status) {
        runAction('status:' + message.id + ':' + status[0], function() {
          project._aiStatus = status[1].trim().slice(0, 15);
          project._aiStatusChanged = true;
        });
        display = display.replace(status[0], '').trim();
      }
      var textChanged = message.text !== display;
      message.text = display;
      if (textChanged) {
        message._codexVersion = (Number.isInteger(message._codexVersion) ? message._codexVersion : 0) + 1;
        message._codexUpdatedAt = new Date().toISOString();
        if (!message._codexWriterId && typeof CodexModule !== 'undefined' && CodexModule.writerId) message._codexWriterId = CodexModule.writerId;
        message._syncDirty = true;
      }
      message._codexActionCommitted = true;
      message._syncDirty = true;
    }
    if (!chat._codexActionTurns) chat._codexActionTurns = {};
    if (didAction) chat._codexActionTurns[options.turnId] = true;
    AppCore.saveStore();
    return didWork || didAction;
  }

  function updateAffectGraph(aiLabel, userLabel) {
    if (!aiLabel || !userLabel) return;
    var store = AppCore.getStore();
    var edges = store.memorySystem.affectGraph.edges;
    var key = [aiLabel, userLabel].sort().join('::');
    edges[key] = (edges[key] || 0) + 1;
  }

  function getRecentAffectLabels() {
    var store = AppCore.getStore();
    var reflections = store.memorySystem.reflections || [];
    var labels = {};
    var result = [];
    for (var i = 0; i < Math.min(reflections.length, 5); i++) {
      var r = reflections[i];
      if (r.ai_affect_label && !labels[r.ai_affect_label]) { labels[r.ai_affect_label] = true; result.push(r.ai_affect_label); }
      if (r.user_affect_label && !labels[r.user_affect_label]) { labels[r.user_affect_label] = true; result.push(r.user_affect_label); }
    }
    return result;
  }

  function getRecentUserAffectLabels() {
    var store = AppCore.getStore();
    var reflections = store.memorySystem.reflections || [];
    var labels = [];
    for (var i = 0; i < Math.min(reflections.length, 5); i++) {
      if (reflections[i].user_affect_label) labels.push(reflections[i].user_affect_label);
    }
    return labels;
  }

  // ═══════════════════════════════════════════
  //  Command detection & execution
  // ═══════════════════════════════════════════
  function detectCommand(input) {
    var trimmed = input.trim();
    if (trimmed.startsWith('/todo') || trimmed.startsWith('/待办')) {
      return { type: 'todo', prompt: trimmed.replace(/^\/todo\s*/i, '').replace(/^\/待办\s*/, '') };
    }
    if (trimmed.startsWith('/book') || trimmed.startsWith('/书架')) {
      return { type: 'book', prompt: trimmed.replace(/^\/book\s*/i, '').replace(/^\/书架\s*/, '') };
    }
    if (trimmed.startsWith('/litter') || trimmed.startsWith('/猫砂')) {
      return { type: 'litter', prompt: trimmed.replace(/^\/litter\s*/i, '').replace(/^\/猫砂\s*/, '') };
    }
    if (trimmed.startsWith('/help') || trimmed === '/?') {
      return { type: 'help' };
    }
    return null;
  }

  async function executeCommand(cmd, userText) {
    var store = AppCore.getStore();
    switch (cmd.type) {
      case 'litter': {
        var signals = [{ type: 'user_signal', detail: 'explicit /litter command' }];
        var result = typeof generateLitterThought === 'function' ? await generateLitterThought(signals, userText) : null;
        if (result) {
          if (!store.litterThoughts) store.litterThoughts = [];
          var proj3 = getActiveProject(); var chat3 = getActiveChatObj();
          var winName = (proj3 && chat3) ? proj3.name + ' / ' + chat3.name : '';
          store.litterThoughts.unshift({
            id: 'lt' + AppCore.gid(''), content: result.content,
            thought_type: result.thoughtType,
            trigger_type: 'user_signal',
            context_snapshot: userText.slice(0, 200),
            date: AppCore.fmtDate().iso, time: AppCore.nowTime(),
            sourceChatId: store.activeChat, sourceWindow: winName,
            revealed: false
          });
          if (store.litterThoughts.length > 50) store.litterThoughts.length = 50;
          return result.content;
        }
        return '猫砂盆居然是空的……';
      }
      case 'todo': {
        var prompt2 = cmd.prompt || '列出当前待办';
        var activeTodos = store.todos.filter(function(t) { return !t.done; });
        if (activeTodos.length === 0) return '你目前没有待办事项，好好享受当下吧 ✨';
        return '📋 **当前待办：**\n' + activeTodos.map(function(t) {
          if (t.type === 'long') {
            var remain = AppCore.daysBetween(AppCore.fmtDate().iso, t.deadline);
            return '- 🎯 ' + t.text + '（' + t.progress + '%，剩余' + remain + '天）';
          }
          return '- ' + (t.done ? '✓' : '○') + ' ' + t.text + (t.time ? ' ' + t.time : '');
        }).join('\n');
      }
      case 'book': {
        var reading = store.books.filter(function(b) { return b.progress > 0 && b.progress < 100; });
        if (reading.length === 0) return '你目前没有正在阅读的书籍。';
        return '📚 **正在阅读：**\n' + reading.map(function(b) { return '- ' + b.cover + ' 《' + b.title + '》by ' + b.author + '（' + b.progress + '%）'; }).join('\n');
      }
      case 'help': {
        return '**可用命令：**\n- `/todo` — 查看待办\n- `/book` — 查看书架\n- `/help` — 显示此帮助';
      }
      default:
        return null;
    }
  }

  // ═══════════════════════════════════════════
  //  Context menu & project/chat management
  // ═══════════════════════════════════════════
  function showContextMenu(e, type, id, name) {
    e.preventDefault();
    e.stopPropagation();
    contextMenuTarget = { type: type, id: id, name: name };
    var menu = AppCore.$('contextMenu');
    if (!menu) return;
    var items = [];
    if (type === 'project') {
      items.push({ label: '✎ Rename', cls: '', action: "editProjectName('" + id + "')" });
      items.push({ label: '🗑 Delete Project', cls: 'danger', action: "confirmDeleteProject('" + id + "','" + name.replace(/'/g, "\\'") + "')" });
    } else if (type === 'chat') {
      items.push({ label: '✎ Rename', cls: '', action: "editChatName('" + id + "')" });
      items.push({ label: '🗑 Delete Window', cls: 'danger', action: "confirmDeleteChat('" + id + "','" + name.replace(/'/g, "\\'") + "')" });
    }
    menu.innerHTML = items.map(function(i) {
      return '<div class="context-menu-item ' + i.cls + '" onclick="(' + i.action + ')();hideContextMenu()">' + i.label + '</div>';
    }).join('');
    var x = e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || 100;
    var y = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY) || 200;
    menu.style.left = Math.min(x, window.innerWidth - 150) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 120) + 'px';
    menu.classList.add('show');
    setTimeout(function() {
      document.addEventListener('click', hideContextMenu, { once: true });
      document.addEventListener('touchstart', hideContextMenu, { once: true });
    }, 50);
  }

  function hideContextMenu() {
    var menu = AppCore.$('contextMenu');
    if (menu) menu.classList.remove('show');
    contextMenuTarget = null;
  }

  function confirmDeleteProject(pid, name) {
    UIModule.showModal('Delete Project',
      '<p style="font-size:14px;color:var(--text);line-height:1.6;">确定要删除项目 <b>"' + name + '"</b> 吗？</p>' +
      '<p style="font-size:12px;color:var(--danger);margin-top:8px;">所有关联的聊天窗口和记忆将被永久删除。</p>' +
      '<input type="hidden" id="delProjPid" value="' + pid + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'delete', cls: 'confirm', onclick: execDeleteProject }]);
  }

  async function execDeleteProject() {
    var store = AppCore.getStore();
    var pid = AppCore.$('delProjPid').value;
    var deletingProject = getProjectById(pid);
    var codexForDelete = AppCore.getModule('codex');
    if (deletingProject && isCodexProject(deletingProject) && codexForDelete) {
      (deletingProject.chats || []).forEach(function(chat) {
        if (codexForDelete.cancelActive) codexForDelete.cancelActive(pid, chat.id);
      });
      if (codexForDelete.invalidateProject) codexForDelete.invalidateProject(pid, { clearSession: false });
      if (codexForDelete.preservePendingDisconnect) {
        try {
          for (var dpi = 0; dpi < (deletingProject.chats || []).length; dpi++) {
            await codexForDelete.preservePendingDisconnect(pid, deletingProject.chats[dpi].id);
            if (codexForDelete.clearSessionMapping) await codexForDelete.clearSessionMapping(pid, deletingProject.chats[dpi].id);
          }
        } catch (_) {
          UIModule.toast('无法保存 Codex 远程映射，项目未删除。');
          return;
        }
      }
      if (!codexForDelete.preservePendingDisconnect && codexForDelete.invalidateProject) {
        for (var dci = 0; dci < (deletingProject.chats || []).length; dci++) {
          if (codexForDelete.clearSessionMapping) await codexForDelete.clearSessionMapping(pid, deletingProject.chats[dci].id);
        }
      }
    }
    store.projects = store.projects.filter(function(p) { return p.id !== pid; });
    if (store.activeProject === pid) {
      store.activeProject = store.projects.length > 0 ? store.projects[0].id : '';
      var newProj = getActiveProject();
      store.activeChat = newProj && newProj.chats.length > 0 ? newProj.chats[0].id : '';
    }
    store._importing = true;
    UIModule.closeModal();
    renderProjectList();
    updateCurrentProjectLabel();
    renderChatMessages();
    if (codexForDelete && codexForDelete.updateUi) codexForDelete.updateUi();
    UIModule.toast('Project deleted');
  }

  function confirmDeleteChat(cid, name) {
    UIModule.showModal('Delete Chat Window',
      '<p style="font-size:14px;color:var(--text);line-height:1.6;">确定要删除窗口 <b>"' + name + '"</b> 吗？</p>' +
      '<p style="font-size:12px;color:var(--danger);margin-top:8px;">所有消息记录将被永久删除。</p>' +
      '<input type="hidden" id="delChatCid" value="' + cid + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'delete', cls: 'confirm', onclick: execDeleteChat }]);
  }

  async function execDeleteChat() {
    var store = AppCore.getStore();
    var cid = AppCore.$('delChatCid').value;
    var codexForDelete = AppCore.getModule('codex');
    for (var cpi = 0; cpi < store.projects.length; cpi++) {
      if (isCodexProject(store.projects[cpi]) && store.projects[cpi].chats.some(function(chat) { return chat.id === cid; })) {
        var deleteProjectId = store.projects[cpi].id;
        if (codexForDelete && codexForDelete.cancelActive) codexForDelete.cancelActive(deleteProjectId, cid);
        if (codexForDelete && codexForDelete.invalidateChat) codexForDelete.invalidateChat(deleteProjectId, cid, { clearSession: false });
        if (codexForDelete && codexForDelete.preservePendingDisconnect) {
          try {
            await codexForDelete.preservePendingDisconnect(deleteProjectId, cid);
            if (codexForDelete.clearSessionMapping) await codexForDelete.clearSessionMapping(deleteProjectId, cid);
          } catch (_) {
            UIModule.toast('无法保存 Codex 远程映射，聊天未删除。');
            return;
          }
        } else if (codexForDelete && codexForDelete.clearSessionMapping) {
          await codexForDelete.clearSessionMapping(deleteProjectId, cid);
        }
        break;
      }
    }
    for (var pi = 0; pi < store.projects.length; pi++) {
      store.projects[pi].chats = store.projects[pi].chats.filter(function(c) { return c.id !== cid; });
    }
    if (store.activeChat === cid) {
      var proj = getActiveProject();
      store.activeChat = proj && proj.chats.length > 0 ? proj.chats[0].id : '';
    }
    store._importing = true;
    UIModule.closeModal();
    renderProjectList();
    updateCurrentProjectLabel();
    renderChatMessages();
    if (codexForDelete && codexForDelete.updateUi) codexForDelete.updateUi();
    UIModule.toast('Chat window deleted');
  }

  function showPreferenceModal() {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    var pref = proj ? (proj.preference || '') : '';
    var maxLen = 500;
    UIModule.showModal('AI Preference <span style="font-family:var(--font-en);font-size:11px;color:var(--text-lighter);">(project-level · max ' + maxLen.toLocaleString() + ' chars)</span>',
      '<p style="font-size:12px;color:var(--text-lighter);margin-bottom:10px;line-height:1.5;">所有窗口共享此 preference，同步更新。</p>' +
      '<textarea class="modal-input modal-textarea" id="prefInput" placeholder="e.g. 回复请温柔细腻，多用比喻，每次回复不超过三句话……" style="min-height:140px;" maxlength="' + maxLen + '">' + pref + '</textarea>' +
      '<div style="text-align:right;font-family:var(--font-en);font-size:10px;color:var(--text-lighter);margin-top:4px;" id="prefCount">' + pref.length + ' / ' + maxLen + '</div>',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: savePreference }]);
    setTimeout(function() {
      var ta = AppCore.$('prefInput');
      if (ta) ta.addEventListener('input', function() {
        var cnt = AppCore.$('prefCount');
        if (cnt) cnt.textContent = ta.value.length + ' / ' + maxLen;
      });
    }, 100);
  }

  function savePreference() {
    var store = AppCore.getStore();
    var pref = AppCore.$('prefInput').value;
    var proj = getActiveProject();
    if (!proj) { store._importing = true; UIModule.closeModal(); return; }
    proj.preference = pref;
    var pv = AppCore.$('prefVal');
    if (pv) pv.textContent = pref ? pref.slice(0, 20) + '…' : 'edit';
    store._importing = true;
    UIModule.closeModal();
    UIModule.toast('Preference saved');
  }

  function showAiNameModal() {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    var current = (proj && proj.aiName) ? proj.aiName : (store.aiName || 'warmbuddy');
    UIModule.showModal('AI 名称',
      '<input class="modal-input" id="aiNameInput" value="' + AppCore.escapeHtml(current) + '" placeholder="AI 名字" maxlength="20">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: saveAiName }]);
  }

  function saveAiName() {
    var store = AppCore.getStore();
    var v = ((AppCore.$('aiNameInput') && AppCore.$('aiNameInput').value) || '').trim() || 'warmbuddy';
    var proj = getActiveProject();
    if (proj) { if (!proj.aiName) proj.aiName = 'warmbuddy'; proj.aiName = v; }
    else { store.aiName = v; }
    var av = AppCore.$('aiNameVal');
    if (av) av.textContent = v;
    store._importing = true;
    UIModule.closeModal();
    UIModule.toast('AI 名称: ' + v);
  }

  function navigateToDiaryReplySource(chatId, windowName) {
    var store = AppCore.getStore();
    if (chatId) store.activeChat = chatId;
    var parts = windowName.split(' / ');
    var proj = store.projects.find(function(p) { return p.name === parts[0]; });
    if (proj) store.activeProject = proj.id;
    navigate('chat');
    renderChat();
    UIModule.toast('已切换到: ' + windowName);
  }

  function updateCurrentProjectLabel() {
    var p = getActiveProject();
    var c = getActiveChatObj();
    var el = AppCore.$('currentProjectLabel');
    if (el) el.textContent = c ? (p ? p.name : '') + ' / ' + c.name : (p ? p.name : 'project');
  }

  function editProjectName(pid) {
    var store = AppCore.getStore();
    var proj = store.projects.find(function(p) { return p.id === pid; });
    if (!proj) return;
    UIModule.showModal('Rename Project',
      '<input class="modal-input" id="editProjName" value="' + proj.name.replace(/"/g, '&quot;') + '">' +
      '<input type="hidden" id="editProjPid" value="' + pid + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'delete', cls: 'danger', onclick: confirmDeleteProjectFromEdit },
       { label: 'save', cls: 'confirm', onclick: saveEditedProjectName }]);
  }

  function confirmDeleteProjectFromEdit() {
    var store = AppCore.getStore();
    var pid = AppCore.$('editProjPid').value;
    var proj = store.projects.find(function(p) { return p.id === pid; });
    store._importing = true;
    UIModule.closeModal();
    if (proj) confirmDeleteProject(pid, proj.name);
  }

  function saveEditedProjectName() {
    var store = AppCore.getStore();
    var pid = AppCore.$('editProjPid').value;
    var proj = store.projects.find(function(p) { return p.id === pid; });
    if (!proj) { store._importing = true; UIModule.closeModal(); return; }
    var nm = AppCore.$('editProjName').value.trim();
    if (!nm) { store._importing = true; UIModule.closeModal(); return; }
    proj.name = nm;
    store._importing = true;
    UIModule.closeModal();
    renderProjectList();
    updateCurrentProjectLabel();
    UIModule.toast('已重命名');
  }

  function editChatName(cid) {
    var store = AppCore.getStore();
    var found = null;
    for (var ip = 0; ip < store.projects.length; ip++) {
      var cp = store.projects[ip];
      var cc = cp.chats.find(function(x) { return x.id === cid; });
      if (cc) { found = cc; break; }
    }
    if (!found) return;
    UIModule.showModal('Rename Chat',
      '<input class="modal-input" id="editChatName" value="' + found.name.replace(/"/g, '&quot;') + '">' +
      '<input type="hidden" id="editChatCid" value="' + cid + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'delete', cls: 'danger', onclick: confirmDeleteChatFromEdit },
       { label: 'save', cls: 'confirm', onclick: saveEditedChatName }]);
  }

  function confirmDeleteChatFromEdit() {
    var store = AppCore.getStore();
    var cidd = AppCore.$('editChatCid').value;
    var found2 = null;
    for (var ip2 = 0; ip2 < store.projects.length; ip2++) {
      var cp2 = store.projects[ip2];
      var cc2 = cp2.chats.find(function(x) { return x.id === cidd; });
      if (cc2) { found2 = cc2; break; }
    }
    store._importing = true;
    UIModule.closeModal();
    if (found2) confirmDeleteChat(cidd, found2.name);
  }

  function saveEditedChatName() {
    var store = AppCore.getStore();
    var cid3 = AppCore.$('editChatCid').value;
    var found3 = null;
    for (var ip3 = 0; ip3 < store.projects.length; ip3++) {
      var cp3 = store.projects[ip3];
      var cc3 = cp3.chats.find(function(x) { return x.id === cid3; });
      if (cc3) { found3 = cc3; break; }
    }
    if (!found3) { store._importing = true; UIModule.closeModal(); return; }
    var nm2 = AppCore.$('editChatName').value.trim();
    if (!nm2) { store._importing = true; UIModule.closeModal(); return; }
    found3.name = nm2;
    store._importing = true;
    UIModule.closeModal();
    renderProjectList();
    updateCurrentProjectLabel();
    UIModule.toast('已重命名');
  }

  // ═══════════════════════════════════════════
  //  Block 11: Bubble actions, TTS, copy, delete, star, sentence splitting
  // ═══════════════════════════════════════════
  function toggleBubbleActions(event, idx) {
    event.stopPropagation();
    var el = document.getElementById('bubbleActions_' + idx);
    if (!el) return;
    document.querySelectorAll('.bubble-actions').forEach(function(a) { if (a !== el) a.style.display = 'none'; });
    el.style.display = el.style.display === 'none' ? 'flex' : 'none';
  }

  function playTTS(idx) {
    var chat = getActiveChatObj(); if (!chat || !chat.messages[idx]) return;
    var msg = chat.messages[idx].text;
    UIModule.toast('🔊 Playing: ' + msg.slice(0, 30) + '…');
    console.log('[TTS] ElevenLabs TTS called for:', msg);
    if (getActiveChatAiSettings().aiVoice) {
      console.log('[TTS] Voice mode enabled — would call ElevenLabs API');
    }
  }

  function copyBubble(idx) {
    var chat = getActiveChatObj(); if (!chat || !chat.messages[idx]) return;
    navigator.clipboard.writeText(chat.messages[idx].text).then(function() { UIModule.toast('📋 已复制到剪贴板'); }).catch(function() { UIModule.toast('复制失败'); });
  }

  function deleteBubble(idx) {
    var store = AppCore.getStore();
    var chat = getActiveChatObj(); if (!chat || !chat.messages[idx]) return;
    if (!confirm('确定要删除这条消息吗？')) return;
    var msg = chat.messages[idx];
    chat.messages.splice(idx, 1);
    AppCore.saveStore();
    renderChatMessages();
    if (msg.id) {
      fetch(AppCore.BACKEND_URL + '/api/delete-message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id })
      }).catch(function() {});
    }
    UIModule.toast('🗑 已删除');
  }

  function starBubble(idx) {
    var chat = getActiveChatObj(); if (!chat || !chat.messages[idx]) return;
    var msg = chat.messages[idx];
    if (msg._starredOnce) { UIModule.toast('已星标过此消息'); return; }
    // Delegate to the unified USM creation flow
    createUserStarredMemory([msg.id]);
  }

  var BUBBLE_LIST_ITEM_RE = /^\s*(?:(?:\d+|[一二三四五六七八九十百]+)[.)、](?=\s|[^\d]|$)|[①-⑳](?=\s|[^\d]|$)|[-*•](?=\s|$))/;
  var BUBBLE_CLOSING_CHARS = '”’"\'」』）》）】〕〉》］]}';
  var BUBBLE_ABBREVIATIONS = {
    'mr': true, 'mrs': true, 'ms': true, 'dr': true, 'prof': true,
    'sr': true, 'jr': true, 'etc': true, 'vs': true, 'e.g': true, 'i.e': true
  };
  var BUBBLE_FALLBACK_RE = /^[\s\S]+$/;

  function isBubbleWhitespace(ch) {
    return !!ch && /\s/.test(ch);
  }

  function isBubbleSentencePunctuation(ch) {
    return ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?';
  }

  function isBubbleClosingChar(ch) {
    return BUBBLE_CLOSING_CHARS.indexOf(ch) >= 0;
  }

  function getBubbleLineStart(text, index) {
    var lineStart = index;
    while (lineStart > 0 && text.charAt(lineStart - 1) !== '\n') lineStart--;
    return lineStart;
  }

  function isBubbleListItemStart(text, index) {
    return BUBBLE_LIST_ITEM_RE.test(text.slice(getBubbleLineStart(text, index)));
  }

  function isBubbleListMarkerDot(text, index) {
    if (text.charAt(index) !== '.') return false;
    if (index + 1 < text.length && /\d/.test(text.charAt(index + 1))) return false;
    var lineStart = getBubbleLineStart(text, index);
    return /^\s*\d+\.$/.test(text.slice(lineStart, index + 1));
  }

  function isBubbleUrlPunctuation(text, index) {
    var ch = text.charAt(index);
    if (ch !== '.' && ch !== '!' && ch !== '?') return false;
    var prefix = text.slice(0, index);
    var urlMatch = prefix.match(/(?:https?:\/\/|www\.)\S*$/i);
    if (!urlMatch) return false;
    var next = text.charAt(index + 1);
    return !!next && !isBubbleWhitespace(next) && /[A-Za-z0-9/#?&=._~%+\-]/.test(next);
  }

  function isBubbleDomainOrEmailDot(text, index) {
    if (text.charAt(index) !== '.') return false;
    var allowed = /[A-Za-z0-9@._%+\-]/;
    var start = index;
    var end = index + 1;
    while (start > 0 && allowed.test(text.charAt(start - 1))) start--;
    while (end < text.length && allowed.test(text.charAt(end))) end++;
    var token = text.slice(start, end);
    return token.indexOf('@') >= 0 || /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(token);
  }

  function isBubbleAbbreviationPeriod(text, index) {
    if (text.charAt(index) !== '.') return false;
    var next = index + 1;
    while (next < text.length && isBubbleWhitespace(text.charAt(next))) next++;
    if (next >= text.length || !/[A-Za-z]/.test(text.charAt(next))) return false;
    var prefix = text.slice(0, index + 1);
    var match = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z](?:\.[A-Za-z])?|[A-Za-z]{2,})\.$/);
    return !!(match && BUBBLE_ABBREVIATIONS[match[1].toLowerCase()]);
  }

  function isBubblePeriodBoundary(text, index) {
    if (isBubbleListMarkerDot(text, index)) return false;
    if (isBubbleUrlPunctuation(text, index)) return false;
    if (isBubbleDomainOrEmailDot(text, index)) return false;
    if (isBubbleAbbreviationPeriod(text, index)) return false;
    if (/\d/.test(text.charAt(index - 1)) && /\d/.test(text.charAt(index + 1))) return false;
    return true;
  }

  function splitSentences(text) {
    if (!text || !text.trim()) return [];

    var source = text.trim();
    var sentences = [];
    var start = 0;

    function pushPart(end) {
      var part = source.slice(start, end).trim();
      if (part) sentences.push(part);
    }

    for (var i = 0; i < source.length;) {
      var ch = source.charAt(i);

      // A plain newline is soft whitespace. It only creates a boundary when
      // the following line starts a new list item.
      if (ch === '\n') {
        var next = i + 1;
        while (next < source.length && /[ \t\r]/.test(source.charAt(next))) next++;
        if (next < source.length && isBubbleListItemStart(source, next) && source.slice(start, i).trim()) {
          pushPart(i);
          start = next;
          i = next;
          continue;
        }
        i++;
        continue;
      }

      var isBoundary = (isBubbleSentencePunctuation(ch) && !isBubbleUrlPunctuation(source, i)) ||
        (ch === '.' && isBubblePeriodBoundary(source, i));
      if (!isBoundary) {
        i++;
        continue;
      }

      var boundaryEnd = i + 1;
      while (boundaryEnd < source.length && isBubbleSentencePunctuation(source.charAt(boundaryEnd))) boundaryEnd++;
      while (boundaryEnd < source.length && isBubbleClosingChar(source.charAt(boundaryEnd))) boundaryEnd++;

      if (source.slice(start, boundaryEnd).trim()) {
        pushPart(boundaryEnd);
        start = boundaryEnd;
      }
      i = boundaryEnd;
    }

    pushPart(source.length);

    // Conservative fallback: keep the entire payload rather than applying a
    // broad period/newline regex that can manufacture orphan bubbles.
    if (sentences.length === 0) {
      var fallbackMatch = source.match(BUBBLE_FALLBACK_RE);
      if (fallbackMatch) sentences.push(fallbackMatch[0].trim());
    }
    return sentences;
  }

  async function displaySentences(sentences, chat, createdAt, replyTo, pendingToolCalls) {
    var typingArea = AppCore.$('chatTypingArea');
    var messagesEl = AppCore.$('chatMessages');

    for (var i = 0; i < sentences.length; i++) {
      if (i > 0) {
        typingArea.innerHTML = '<div class="typing-indicator">对方正在输入中<span class="streaming-cursor">|</span></div>';
        await new Promise(function(r) { return setTimeout(r, 400 + Math.random() * 500); });
      }
      typingArea.innerHTML = '';

      var msg = createChatMessage({ role: 'ai', text: sentences[i], id: AppCore.generateMsgId() }, createdAt);
      if (i === 0 && replyTo) msg.replyTo = replyTo;
      if (i === 0 && pendingToolCalls) msg._toolCalls = pendingToolCalls;
      chat.messages.push(msg);
      renderChatMessages();

      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

      if (i < sentences.length - 1) {
        await new Promise(function(r) { return setTimeout(r, 150); });
      }
    }
  }

  function parseAIBubbles(rawText) {
    if (!rawText) return [];
    var parts = rawText.split(/\[\[BUBBLE\]\]/i);
    var bubbles = [];
    for (var i = 0; i < parts.length; i++) {
      var text = parts[i].trim();
      if (!text) continue;
      var replyTo = null;
      var replyMatch = text.match(/^\[\[REPLY:([^\]]+)\]\]/);
      if (replyMatch) {
        replyTo = replyMatch[1].trim();
        text = text.slice(replyMatch[0].length).trim();
      }
      text = text.replace(/\[\[REPLY:[^\]]+\]\]/g, '').trim();
      if (text) bubbles.push({ text: text, replyTo: replyTo });
    }
    return bubbles;
  }

  async function displayAIBubbles(bubbles, chat, createdAt) {
    var typingArea = AppCore.$('chatTypingArea');
    var messagesEl = AppCore.$('chatMessages');

    var sentMessageIds = [];
    for (var i = 0; i < bubbles.length; i++) {
      var bubble = bubbles[i];
      if (i > 0) {
        typingArea.innerHTML = '<div class="typing-indicator">对方正在输入中<span class="streaming-cursor">|</span></div>';
        await new Promise(function(r) { return setTimeout(r, 400 + Math.random() * 500); });
      }
      typingArea.innerHTML = '';

      var msg = createChatMessage({ role: 'ai', text: bubble.text, id: AppCore.generateMsgId() }, createdAt);
      if (bubble.replyTo) msg.replyTo = bubble.replyTo;
      chat.messages.push(msg);
      sentMessageIds.push(msg.id);
      renderChatMessages();

      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

      if (i < bubbles.length - 1) {
        await new Promise(function(r) { return setTimeout(r, 150); });
      }
    }
  }

  // ═══════════════════════════════════════════
  //  Block 10b: triggerAIResponse (the big one)
  // ═══════════════════════════════════════════
  async function triggerAIResponse(chat, userText, diaryIntent, options) {
    options = options || {};
    var routeProjectId = options.projectId || AppCore.getStore().activeProject;
    var routeProject = getProjectById(routeProjectId);
    if (isCodexProject(routeProject)) {
      var codex = (typeof CodexModule !== 'undefined' ? CodexModule : AppCore.getModule('codex'));
      if (!codex || !codex.sendChatTurn) throw new Error('CODEX_NOT_READY');
      return codex.sendChatTurn({
        projectId: routeProjectId,
        chatId: options.chatId || chat.id,
        userMessageIds: options.currentMessageIds || [],
        userText: userText,
        diaryIntent: diaryIntent,
        replyTo: options.replyTo
      });
    }
    var store = AppCore.getStore();
    var typingArea = AppCore.$('chatTypingArea');
    var cfg = getActiveApiConfig();
    var pendingToolCalls = null;
    var interactionId = 'int_' + AppCore.gid('');
    var tokenUsageEvents = [];

    // ═══ Build enabled tool definitions for this window ═══
    var enabledToolDefs = null;
    var tkm = AppCore.getModule('toolkit');
    if (tkm && chat.enabledTools && chat.enabledTools.length > 0) {
      var allDefs = tkm.getDefinitions();
      enabledToolDefs = allDefs.filter(function(d) { return chat.enabledTools.indexOf(d.id) >= 0; });
      console.log('[MCP-debug] Sending enabledToolDefs:', enabledToolDefs.length, 'tool(s), IDs:', chat.enabledTools);
    }

    if (detectRecallIntent(userText)) {
      var retrievalBlock = buildRetrievalBlock(userText);
      if (retrievalBlock) chat._pendingRetrievalBlock = retrievalBlock;
    }

    // 日记按需读取兜底：正则命中则强制注入【日记】块（无视快照状态）
    if (/日记|读.*日记|看.*日记|最近写了|日记本|翻.*日记/.test(userText || '')) {
      if (chat && chat._dynCtxSnapshot) chat._dynCtxSnapshot.diary = '';
      _dynCtxCache.fp = '';
    }

    var dynamicBlock = buildDynamicContextBlock();

    var emotionalBlock = buildEmotionalRecallBlock(userText);
    if (emotionalBlock) dynamicBlock += '\n' + emotionalBlock;

    if (diaryIntent === 'diary_write') {
      dynamicBlock += '\n【当前任务】用户让你写一篇你自己视角的日记。使用 [[DIARY:标题|心情|正文]] 标记，标记外正常回复可简短。';
    }

    var customPromptContext = '';
    var customPromptModule = AppCore.getModule('customPrompts');
    if (customPromptModule && customPromptModule.beginAiRound) {
      var customPromptRound = customPromptModule.beginAiRound(chat);
      customPromptContext = customPromptRound && customPromptRound.content || '';
    }

    var apiMessages = [];

    var L1_ROUNDS = 6;
    var L2_END = 30;

    var allRounds = groupMessagesIntoRounds(chat.messages);
    var totalRounds = allRounds.length;

    var l1Rounds = allRounds.slice(-L1_ROUNDS);
    var l2StartIdx = Math.max(0, totalRounds - L2_END);
    var l2EndIdx = totalRounds - L1_ROUNDS;
    var l2Rounds = allRounds.slice(l2StartIdx, l2EndIdx);

    apiMessages.push({ role: 'system', content: SYSTEM_PROMPT_STATIC });
    apiMessages.push({ role: 'system', content: dynamicBlock });
    if (customPromptContext) apiMessages.push({ role: 'system', content: customPromptContext });
    var sharedDiaryBlock = pendingSharedDiaryContext(chat);
    if (sharedDiaryBlock) apiMessages.push({ role: 'system', content: sharedDiaryBlock });

    var recentMsgIds = buildRecentMsgIdBlock(chat);
    apiMessages.push({ role: 'system', content: '【可引用消息ID】\n' + recentMsgIds });

    if (l2Rounds.length > 0 && chat._roundSummaries && chat._roundSummaries.length > 0) {
      var l2Summary = chat._roundSummaries[chat._roundSummaries.length - 1];
      if (l2Summary && l2Summary.summary) {
        apiMessages.push({ role: 'system', content: '【较早对话摘要】' + l2Summary.summary });
      }
    } else if (l2Rounds.length > 0 && l2Rounds.length >= 5) {
      queueRoundCompression(chat, l2Rounds);
    }

    // 近期 6 轮有 USM 更新（存在 _starred 消息）则注入最近 USM summary
    var hasRecentUSM = false;
    for (var rui = 0; rui < l1Rounds.length; rui++) {
      var l1RoundMsgs = l1Rounds[rui].msgs || [];
      for (var ruj = 0; ruj < l1RoundMsgs.length; ruj++) {
        if (l1RoundMsgs[ruj]._starred && l1RoundMsgs[ruj].role !== 'system') { hasRecentUSM = true; break; }
      }
      if (hasRecentUSM) break;
    }
    if (hasRecentUSM) {
      var cmlUSM = MemoryModule.getCML(store.activeProject);
      var recentUSMs = (cmlUSM && cmlUSM.userStarredMemories || []).filter(function(u) { return u.summary; }).slice(0, 2);
      if (recentUSMs.length > 0) {
        apiMessages.push({ role: 'system', content: '【最近星标记忆】' + recentUSMs.map(function(u) { return u.summary; }).join('；') });
      }
    }

    var l1Messages = [];
    for (var ri2 = 0; ri2 < l1Rounds.length; ri2++) {
      var round2 = l1Rounds[ri2];
      for (var rj2 = 0; rj2 < round2.msgs.length; rj2++) {
        var msg2 = round2.msgs[rj2];
        if (msg2.role === 'system') continue;
        if (msg2.contentType === 'shared_diary') continue;
        var apiRole = msg2.role === 'ai' || msg2.role === 'assistant' ? 'assistant' : 'user';

        var content1 = msg2.text || '';
        if (msg2.replyTo && apiRole === 'user') {
          var quoted = chat.messages.find(function(m) { return m.id === msg2.replyTo; });
          if (quoted) {
            var qLabel = quoted.role === 'user' ? AppCore.USER_NAME : getAIName();
            var qText = (quoted.text || '').slice(0, 150);
            content1 = '[引用' + qLabel + '的消息：「' + qText + '」]\n' + content1;
          }
        }

        if (l1Messages.length > 0 && l1Messages[l1Messages.length - 1].role === 'user' && apiRole === 'user') {
          l1Messages[l1Messages.length - 1].content += '\n' + content1;
        } else {
          l1Messages.push({ role: apiRole, content: content1 });
        }
      }
    }
    apiMessages.push.apply(apiMessages, l1Messages);

    var l1Tokens = 0;
    for (var ri3 = 0; ri3 < l1Rounds.length; ri3++) {
      var round3 = l1Rounds[ri3];
      for (var rj3 = 0; rj3 < round3.msgs.length; rj3++) {
        var msg3 = round3.msgs[rj3];
        if (msg3.role !== 'system') l1Tokens += estimateTokens(msg3.text || '');
      }
    }
    if (l1Tokens > 6000) {
      triggerWindowHandoff(chat, l1Rounds.flatMap(function(r) {
        return r.msgs.filter(function(m) { return m.role !== 'system'; }).map(function(m) {
          return { msg: m, tokens: estimateTokens(m.text || '') };
        });
      }));
    }

    var fullResponse = '';
    var tokenUsage = null;
    var bubbleAt = new Date();

    try {
      var agentGatewayProject = isAgentGatewayProject(getActiveProject());
      var requestUrl = AppCore.BACKEND_URL + (agentGatewayProject ? '/api/agent/stream' : '/api/chat/stream');
      var requestBody = agentGatewayProject
        ? {
          projectId: 'claude-code-test',
          windowId: chat.id,
          interactionId: interactionId,
          messages: apiMessages
        }
        : {
          apiKey: cfg.apiKey,
          endpoint: cfg.endpoint,
          model: cfg.model,
          projectId: store.activeProject,
          windowId: chat.id,
          interactionId: interactionId,
          tokenContext: { actionType: (chat.enabledTools && chat.enabledTools.length > 0) ? 'mcp' : 'chat', interactionId: interactionId },
          enabledToolIds: chat.enabledTools || [],
          enabledToolDefs: enabledToolDefs,
          messages: apiMessages
        };
      var response = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        typingArea.innerHTML = '';
        chat.messages.push(createChatMessage({ role: 'ai', text: '连接API失败，请检查配置。', id: AppCore.generateMsgId() }, bubbleAt));
        renderChatMessages();
        return;
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var readerResult = await reader.read();
        var done = readerResult.done;
        var value = readerResult.value;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          if (!line.trim() || !line.startsWith('data: ')) continue;
          var data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            var parsed = JSON.parse(data);
            if (parsed.error) { fullResponse = parsed.error; break; }
            if (parsed._toolCalls) { pendingToolCalls = parsed._toolCalls; }
            if (parsed.usageEvent) { tokenUsageEvents.push(parsed.usageEvent); }
            if (parsed.text) {
              fullResponse += parsed.text;
              if (typingArea && typingArea.innerHTML) {
                if (ArtifactsModule.isGeneratingArtifact(fullResponse)) {
                  typingArea.innerHTML = '<div class="typing-indicator">musing<span class="streaming-cursor">……</span></div>';
                } else {
                  typingArea.innerHTML = '';
                }
              }
            }
            if (parsed.usage) { tokenUsage = parsed.usage; }
          } catch (e) {}
        }
      }

      if (!fullResponse) {
        fullResponse = '（对方沉默了……也许在思考什么。）';
      }

    } catch (err) {
      console.error('Stream error:', err);
      fullResponse = '连接不到陪伴小站，请确保后端已启动。';
    }

    // ── Web Search: two-pass mechanism ──
    var searchMarker = fullResponse.match(/\[\[SEARCH:(.+?)\]\]/);
    if (searchMarker && getActiveChatAiSettings().webSearch) {
      var searchQuery = searchMarker[1].trim();
      if (searchQuery) {
        fullResponse = fullResponse.replace(/\[\[SEARCH:.+?\]\]/, '').trim();
        typingArea.innerHTML = '<div class="typing-indicator">正在搜索: ' + AppCore.escapeHtml(searchQuery) + '...</div>';

        try {
          var searchResp = await fetch(AppCore.BACKEND_URL + '/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: searchQuery })
          });
          var searchData = await searchResp.json();
          var searchResults = searchData.results || '(no results)';

          chat.messages.push(createChatMessage({
            role: 'user',
            text: '[系统] 网络搜索结果（搜索词: ' + searchQuery + '）: ' + searchResults,
            _searchResult: true,
            id: AppCore.generateMsgId()
          }, new Date()));

          var newDynamicBlock = buildDynamicContextBlock();
          var apiMessages2 = [
            { role: 'system', content: SYSTEM_PROMPT_STATIC },
            { role: 'system', content: newDynamicBlock }
          ];
          if (customPromptContext) apiMessages2.push({ role: 'system', content: customPromptContext });
          for (var mi2 = 0; mi2 < chat.messages.length; mi2++) {
            var m3 = chat.messages[mi2];
            if (m3.role === 'system' || m3._searchResult) continue;
            apiMessages2.push({
              role: m3.role === 'ai' ? 'assistant' : m3.role,
              content: m3.text
            });
          }

          fullResponse = '';
          tokenUsage = null;
          var response2 = await fetch(AppCore.BACKEND_URL + '/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiKey: cfg.apiKey,
              endpoint: cfg.endpoint,
              model: cfg.model,
              projectId: store.activeProject,
              windowId: chat.id,
              interactionId: interactionId,
              tokenContext: { actionType: 'web_search', stage: 'followup', interactionId: interactionId },
              enabledToolIds: chat.enabledTools || [],
              enabledToolDefs: enabledToolDefs,
              messages: apiMessages2
            })
          });

          if (response2.ok) {
            var reader2 = response2.body.getReader();
            var decoder2 = new TextDecoder();
            var buffer2 = '';
            while (true) {
              var rr2 = await reader2.read();
              if (rr2.done) break;
              buffer2 += decoder2.decode(rr2.value, { stream: true });
              var lines2 = buffer2.split('\n');
              buffer2 = lines2.pop() || '';
              for (var li2 = 0; li2 < lines2.length; li2++) {
                var line2 = lines2[li2];
                if (!line2.trim() || !line2.startsWith('data: ')) continue;
                var data2 = line2.slice(6);
                if (data2 === '[DONE]') continue;
                try {
                  var parsed2 = JSON.parse(data2);
                  if (parsed2.error) { fullResponse = parsed2.error; break; }
                  if (parsed2._toolCalls) { pendingToolCalls = parsed2._toolCalls; }
                  if (parsed2.usageEvent) { tokenUsageEvents.push(parsed2.usageEvent); }
                  if (parsed2.text) {
                    fullResponse += parsed2.text;
                    if (typingArea && typingArea.innerHTML) {
                      if (ArtifactsModule.isGeneratingArtifact(fullResponse)) {
                        typingArea.innerHTML = '<div class="typing-indicator">musing<span class="streaming-cursor">……</span></div>';
                      } else {
                        typingArea.innerHTML = '';
                      }
                    }
                  }
                  if (parsed2.usage) { tokenUsage = parsed2.usage; }
                } catch (e) {}
              }
            }
          }

          if (!fullResponse) {
            fullResponse = '（搜索完成，但AI没有生成回复……）';
          }
        } catch (searchErr) {
          console.error('[search] Two-pass error:', searchErr);
          if (!fullResponse) fullResponse = '（搜索失败，请稍后重试）';
        }
      }
    }

    typingArea.innerHTML = '';

    var reflectResult = extractReflection(fullResponse);
    if (reflectResult.reflection) {
      processReflection(reflectResult.reflection, userText, reflectResult.cleanText, chat);
    }
    var displayResponse = reflectResult.cleanText || fullResponse;
    var diaryWritten = false;
    var proj = getActiveProject();
    var winName = (proj && chat) ? proj.name + ' / ' + chat.name : '';

    function extractMarker(text, action) {
      var re = new RegExp('<!--\\s*DIARY:' + action + '\\s*-->([\\s\\S]*?)<!--\\s*\\/DIARY\\s*-->', 'i');
      return text.match(re);
    }

    var diaryStructured = displayResponse.match(/\[\[DIARY:([^\]|]*)\|([^\]|]*)\|([\s\S]*?)\]\]/i);
    var writeMatch = extractMarker(displayResponse, 'write');
    if (diaryStructured || writeMatch) {
      var diaryTitle1 = diaryStructured ? diaryStructured[1].trim().slice(0, 15) : '';
      var diaryMood1 = diaryStructured ? diaryStructured[2].trim() : 'calm';
      var diaryContent1 = diaryStructured ? diaryStructured[3].trim() : writeMatch[1].trim();
      var diaryMarker = diaryStructured ? diaryStructured[0] : writeMatch[0];
      displayResponse = displayResponse.replace(diaryMarker, '');
      if (diaryContent1) {
        var now4 = new Date();
        var diaryEntry = {
          id: 'd' + AppCore.gid(''), date: AppCore.fmtDate().iso,
          time: String(now4.getHours()).padStart(2, '0') + ':' + String(now4.getMinutes()).padStart(2, '0'),
          title: diaryTitle1 || diaryContent1.slice(0, 15), content: diaryContent1, mood: diaryMood1 || 'calm', author: 'ai', replies: [],
          sourceChatId: store.activeChat, sourceProjectId: store.activeProject, sourceWindow: winName,
          visibilityMode: 'selected', visibleChatIds: [store.activeChat], createdAt: now4.toISOString()
        };
        store.diaries.unshift(diaryEntry);
        var diaryModule = AppCore.getModule('diary');
        if (diaryModule && diaryModule.addDelivery) diaryModule.addDelivery(diaryEntry.id, store.activeProject, store.activeChat, 'visibility');
        if (diaryModule && diaryModule.syncEntry) diaryModule.syncEntry(diaryEntry);
        diaryWritten = true;
      }
    }

    var replyMatch = extractMarker(displayResponse, 'reply');
    if (replyMatch) {
      var replyContent = replyMatch[1].trim();
      displayResponse = displayResponse.replace(replyMatch[0], '');
      if (replyContent) {
        var userEntries = store.diaries.filter(function(d) { return d.author === 'user'; });
        if (userEntries.length > 0) {
          var target = userEntries[0];
          if (!target.replies) target.replies = [];
          var now5 = new Date();
          target.replies.push({
            id: 'r' + AppCore.gid(''), content: replyContent, author: 'ai',
            date: AppCore.fmtDate().iso,
            time: String(now5.getHours()).padStart(2, '0') + ':' + String(now5.getMinutes()).padStart(2, '0'),
            sourceChatId: store.activeChat, sourceWindow: winName
          });
          diaryWritten = true;
        }
      }
    }

    displayResponse = displayResponse.replace(/<!--\s*\/?DIARY:\w*\s*-->[\s\S]*?<!--\s*\/DIARY\s*-->/gi, '');
    displayResponse = displayResponse.replace(/<!--\s*\/?DIARY:?\w*\s*-->/gi, '');
    displayResponse = displayResponse.trim();

    // ── 猫砂盆主聊天写入路径（AI 主动输出 <!--LITTER:type-->...<!--/LITTER-->）──
    var litterMatch = displayResponse.match(/<!--\s*LITTER(?::([^>]*?))?\s*-->([\s\S]*?)<!--\s*\/LITTER\s*-->/i);
    if (litterMatch) {
      var litterType = (litterMatch[1] || '').trim();
      var litterContent = (litterMatch[2] || '').trim();
      displayResponse = displayResponse.replace(litterMatch[0], '').trim();
      var litterMod = AppCore.getModule('litterbox');
      if (litterMod && litterMod.ingestFromMainChat) {
        litterMod.ingestFromMainChat(litterContent, litterType, chat);
      }
    }

    // ── [[CORE_OVERVIEW:...]] marker ──
    var coreOverviewMatch = displayResponse.match(/\[\[CORE_OVERVIEW:([\s\S]*?)\]\]/);
    if (coreOverviewMatch) {
      var overviewContent = coreOverviewMatch[1].trim().slice(0, 500);
      displayResponse = displayResponse.replace(coreOverviewMatch[0], '').trim();
      var proj = getActiveProject();
      var aiName = (proj && proj.aiName) ? proj.aiName : 'warmbuddy';
      // Save locally first (so UI shows it immediately, survives refresh even if Supabase is down)
      var mm = AppCore.getModule('memory');
      if (mm && mm.setCoreOverviewLocal) {
        mm.setCoreOverviewLocal(overviewContent, aiName);
      }
      chat.messages.push(createChatMessage({ role: 'system', contentType: 'core_overview_update', text: '核心概述已更新', id: AppCore.generateMsgId() }, bubbleAt));
    }

    var extractedTodos = extractTodosFromResponse(displayResponse);
    if (extractedTodos.length > 0) {
      var hasNewTodo = false;
      for (var ti = 0; ti < extractedTodos.length; ti++) {
        var et = extractedTodos[ti];
        var exists = store.todos.some(function(t) {
          return t.text.toLowerCase() === et.title.toLowerCase();
        });
        if (!exists) {
          store.todos.unshift({
            id: 't' + AppCore.gid(''), text: et.title, done: false,
            time: et.deadline, type: 'short', creator: 'ai',
            chatId: chat.id || ''
          });
          hasNewTodo = true;
        }
      }
      if (hasNewTodo) {
        chat.messages.push(createChatMessage({ role: 'system', contentType: 'todo_notification', text: '有了新的to-do' }, bubbleAt));
        AppCore.saveStore();
        SyncModule.syncTodosToBackend();
      }
      displayResponse = displayResponse.replace(/\[\[TODO:[^\]]+\]\]/g, '').trim();
    }
    displayResponse = displayResponse.replace(/<!--\s*MEMORY\s*\{[\s\S]*?\}\s*-->/gi, '').trim();

    var emailData = extractEmailFromResponse(displayResponse);
    if (emailData) {
      displayResponse = displayResponse.replace(/\[\[EMAIL:[^\]]+\]\]/, '').trim();
      var subject = emailData.subject || '无主题';
      handleEmailSend(chat, subject, emailData.body);
    }

    var pokeMatch = displayResponse.match(/\[\[POKE(?:\:[^\]]*)?\]\]/i);
    if (pokeMatch) {
      displayResponse = displayResponse.replace(pokeMatch[0], '').trim();
      var aiName = getAIName();
      var userStatus = (proj && proj._userStatus) ? proj._userStatus : '';
      var pokeText = aiName + ' 戳了戳 mays，' + (userStatus ? '她' + userStatus : '她什么也没发生。');
      chat.messages.push(createChatMessage({ role: 'system', contentType: 'poke_notification', text: pokeText, id: AppCore.generateMsgId() }, bubbleAt));
      if (!userStatus) {
        chat.messages.push(createChatMessage({ role: 'system', contentType: 'poke_hint', text: '她现在没有状态。', id: AppCore.generateMsgId() }, bubbleAt));
      }
      if (proj) {
        fetch(AppCore.BACKEND_URL + '/api/poke-events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: proj.id, chatId: chat.id, content: userStatus, source: 'ai' })
        }).catch(function() {});
        proj._userStatusChanged = false;
      }
    }

    var statusMatch = displayResponse.match(/\[\[STATUS:([^\]]+)\]\]/i);
    if (statusMatch) {
      var newStatus = (statusMatch[1] || '').trim().substring(0, 15);
      displayResponse = displayResponse.replace(/\[\[STATUS:[^\]]+\]\]/, '').trim();
      if (proj && newStatus) {
        proj._aiStatus = newStatus;
        proj._aiStatusChanged = true;
        AppCore.saveStore();
        fetch(AppCore.BACKEND_URL + '/api/projects/sync-configs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: proj.id, config: { _aiStatus: newStatus } })
        }).catch(function() {});
      }
    }

    // Artifact markers are now processed at render time (plan B)
    // — intentionally NOT replacing them here to keep m.text raw

    if (diaryWritten) {
      chat.messages.push(createChatMessage({ role: 'system', text: '在日记里写了点什么', id: AppCore.generateMsgId() }, bubbleAt));
      renderChatMessages();
      var dproj = getActiveProject();
      var dchat = getActiveChatObj();
      var dwinName = (dproj && dchat) ? dchat.name : '';
      var diaryAiName = getAIName();
      sendPushNotification(diaryAiName + ' · 日记', diaryAiName + '刚刚写了篇日记', { tag: 'diary-update', url: '/', requireInteraction: false });
      if (!displayResponse || displayResponse === fullResponse) {
        displayResponse = '嗯，已经写好了。你可以去 diary 页面看看～';
      }
    }

    var cleanText = displayResponse || '（对方沉默了……也许在思考什么。）';
    var hasBubbleMarker = /\[\[BUBBLE\]\]/i.test(cleanText);
    var parsedBubbles = parseAIBubbles(cleanText);

    if (hasBubbleMarker && parsedBubbles.length > 0) {
      await displayAIBubbles(parsedBubbles, chat, bubbleAt);
    } else if (parsedBubbles.length === 1) {
      var replyTo = parsedBubbles[0].replyTo;
      var text = parsedBubbles[0].text;
      var hasArtifactCard = text.indexOf('artifact-card-inline') >= 0 || text.indexOf('<!--ARTIFACT_START:') >= 0;
      if (hasArtifactCard) {
        var msgCard = createChatMessage({ role: 'ai', text: text, id: AppCore.generateMsgId() }, bubbleAt);
        if (replyTo) msgCard.replyTo = replyTo;
        if (pendingToolCalls) msgCard._toolCalls = pendingToolCalls;
        chat.messages.push(msgCard);
        renderChatMessages();
      } else {
        var sentences = splitSentences(text);
        if (sentences.length <= 1) {
          var msg1 = createChatMessage({ role: 'ai', text: text, id: AppCore.generateMsgId() }, bubbleAt);
          if (replyTo) msg1.replyTo = replyTo;
          if (pendingToolCalls) msg1._toolCalls = pendingToolCalls;
          chat.messages.push(msg1);
          renderChatMessages();
        } else {
          await displaySentences(sentences, chat, bubbleAt, replyTo, pendingToolCalls);
        }
      }
    } else {
      var mainMsg = createChatMessage({ role: 'ai', text: cleanText, id: AppCore.generateMsgId() }, bubbleAt);
      if (pendingToolCalls) mainMsg._toolCalls = pendingToolCalls;
      chat.messages.push(mainMsg);
      renderChatMessages();
    }

    var inputTokens = 0;
    var outputTokens = 0;
    var estimatedTokens = 0;
    if (tokenUsageEvents.length > 0) {
      for (var tei = 0; tei < tokenUsageEvents.length; tei++) {
        var tokenEvent = tokenUsageEvents[tei];
        AppCore.recordTokenEvent(tokenEvent);
        inputTokens += tokenEvent.inputTokens || 0;
        outputTokens += tokenEvent.outputTokens || 0;
        estimatedTokens += tokenEvent.totalTokens || 0;
      }
    } else {
      inputTokens = tokenUsage
        ? (tokenUsage.input_tokens || tokenUsage.prompt_tokens || 0)
        : estimateTokens(userText);
      outputTokens = tokenUsage
        ? (tokenUsage.output_tokens || tokenUsage.completion_tokens || 0)
        : Math.ceil(fullResponse.length / 1.5);
      estimatedTokens = tokenUsage && tokenUsage.total_tokens !== undefined
        ? tokenUsage.total_tokens
        : inputTokens + outputTokens;
      AppCore.logTokenCall(store.activeChat, 'chat', inputTokens, outputTokens,
        tokenUsage ? (tokenUsage.cache_read_input_tokens || 0) : 0,
        tokenUsage ? (tokenUsage.cache_creation_input_tokens || 0) : 0,
        cfg.model, {
          totalTokens: estimatedTokens,
          isEstimated: !tokenUsage,
          interactionId: interactionId,
          stage: 'single'
        });
    }

    renderChatMessages();
    renderProjectList();

    (AppCore.getModule('litterbox')||{}).trigger(userText, fullResponse);
    (AppCore.getModule('memory')||{}).applyForgettingCurve();

    chat.lastInteractionTime = new Date().toISOString();

    SyncModule.syncProjectConfigToBackend(true);
    SyncModule.scheduleMessageSync();
    consumeSharedDiaryDeliveries(chat);
  }

  // ═══════════════════════════════════════════
  //  Block 12: Draft system
  // ═══════════════════════════════════════════
  function stageDraftBubble() {
    var input = AppCore.$('chatInput');
    var text = input.value.trim();
    if (!text) return;
    var draft = { text: text };
    if (pendingReply) {
      draft.replyTo = pendingReply.msgId;
      draft.replyLabel = pendingReply.label;
      draft.replyText = pendingReply.text;
      pendingReply = null;
      renderReplyPreview();
    }
    draftBubbles.push(draft);
    input.value = '';
    input.style.height = 'auto';
    renderDraftBubbles();
    updateSendButtonState();
    UIModule.toast('已暂存草稿 (' + draftBubbles.length + ')');
  }

  function renderDraftBubbles() {
    var area = AppCore.$('draftBubblesArea');
    var scroll = AppCore.$('draftBubblesScroll');
    var plusBtn = AppCore.$('chatSendPlus');
    if (draftBubbles.length === 0) {
      area.style.display = 'none';
      if (plusBtn) plusBtn.classList.remove('has-drafts');
      return;
    }
    area.style.display = 'block';
    if (plusBtn) plusBtn.classList.add('has-drafts');
    var html = '';
    draftBubbles.forEach(function(d, i) {
      var replyHint = d.replyTo ? '<span style="font-size:9px;color:var(--accent);">↩' + AppCore.escapeHtml(d.replyLabel || '') + '</span> ' : '';
      html += '<div class="draft-bubble-chip" onclick="openDraftEditor(' + i + ')" title="点击编辑"><span class="draft-chip-index">#' + (i + 1) + '</span>' + replyHint + AppCore.escapeHtml(d.text.slice(0, 60)) + (d.text.length > 60 ? '...' : '') + '</div>';
    });
    scroll.innerHTML = html;
  }

  function updateSendButtonState() {
    var btn = AppCore.$('chatSendBtn');
    var plusBtn = AppCore.$('chatSendPlus');
    var input = AppCore.$('chatInput');
    if (!btn) return;
    var hasInput = input.value.trim().length > 0;
    var hasDrafts = draftBubbles.length > 0;

    if (plusBtn) plusBtn.style.display = hasInput ? 'flex' : 'none';

    if (hasDrafts && !hasInput) {
      btn.classList.add('virtual');
    } else {
      btn.classList.remove('virtual');
    }
  }

  function toggleMoreMenu() {
    var menu = AppCore.$('moreMenu');
    if (!menu) return;
    if (menu.style.display === 'none' || !menu.style.display) {
      menu.style.display = 'flex';
      setTimeout(function() {
        document.addEventListener('click', closeMoreMenuOnClick, { once: true });
      }, 50);
    } else {
      menu.style.display = 'none';
    }
  }

  function closeMoreMenuOnClick(e) {
    var menu = AppCore.$('moreMenu');
    var btn = AppCore.$('chatAttachBtn');
    if (menu && btn && !menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
    }
  }

  function closeMoreMenu() {
    var menu = AppCore.$('moreMenu');
    if (menu) menu.style.display = 'none';
  }

  function openPokeSettings() {
    var proj = getActiveProject();
    var currentStatus = (proj && proj._userStatus) ? proj._userStatus : '';
    UIModule.showModal('你当前的状态',
      '<div style="text-align:center;">' +
      '<input class="modal-input" id="pokeMessageInput" placeholder="输入你的状态" value="' + AppCore.escapeHtml(currentStatus) + '" maxlength="15" style="text-align:center;font-size:16px;">' +
      '<div style="font-size:11px;color:var(--text-lighter);margin-top:6px;">（最多15字）</div>' +
      '</div>',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: '保存', cls: 'confirm', onclick: savePokeSettings }]);
  }

  function savePokeSettings() {
    var store = AppCore.getStore();
    var input = AppCore.$('pokeMessageInput');
    if (!input) return;
    var status = input.value.trim().substring(0, 15);
    var proj = getActiveProject();
    if (proj) {
      proj._userStatus = status;
      proj._userStatusChanged = true;
      AppCore.saveStore();
      fetch(AppCore.BACKEND_URL + '/api/user-status', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: proj.id, status: status })
      }).catch(function(e) { console.warn('[status] PUT failed:', e.message); });
    }
    UIModule.closeModal(); UIModule.toast('状态已更新');
  }

  function handleAIAvatarDblClick() {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    var chat = getActiveChatObj();
    if (!proj || !chat) return;
    var aiStatus = (proj && proj._aiStatus) ? proj._aiStatus : '';
    var aiName = getAIName();
    var statusText = aiStatus ? 'TA' + aiStatus : 'TA什么也没发生';
    var now = new Date();
    chat.messages.push(createChatMessage({ role: 'system', contentType: 'poke_notification', text: 'mays 戳了戳 ' + aiName + '，' + statusText, id: AppCore.generateMsgId() }, now));
    if (proj._aiStatusChanged) { proj._aiStatusChanged = false; }
    renderChatMessages();
    AppCore.saveStore();
    fetch(AppCore.BACKEND_URL + '/api/poke-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: proj.id, chatId: chat.id, content: aiStatus, source: 'user' })
    }).catch(function() {});
    UIModule.toast('戳了戳 ' + aiName);
  }

  async function sendAllDraftBubbles() {
    var store = AppCore.getStore();
    var proj = getActiveProject();
    var chat = getActiveChatObj();
    if (!chat) {
      var p = getActiveProject();
      if (!p) {
        var pid = 'p' + AppCore.gid('');
        store.projects.push({ id: pid, name: 'default', preference: '', apiConfig: { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true }, memories: [], chats: [] });
        store.activeProject = pid; p = getActiveProject();
      }
      var cid = 'c' + AppCore.gid('');
      p.chats.push({
        id: cid, name: (draftBubbles[0] ? draftBubbles[0].text : '').slice(0, 20),
        aiSettings: { autoDateTime: getActiveChatAiSettings().autoDateTime, autoWeather: getActiveChatAiSettings().autoWeather, aiVoice: getActiveChatAiSettings().aiVoice, webSearch: getActiveChatAiSettings().webSearch },
        emailEnabled: false,
        enabledTools: [],
        customPromptRound: 0,
        customPromptStates: {},
        sharedMemoryIds: [], weeklyExports: [], artifacts: [],
        messages: [], chatTokens: 0,
        lastConversationDate: AppCore.fmtDate().iso, lastActiveDate: null, lastInteractionTime: null,
        _messageCount: 0, _lastSummaryIdx: 0,
        _handoffSuggested: false, _sharedMemoryLoaded: true,
        _sharedMemoryLoadedAt: new Date().toISOString()
      });
      store.activeChat = cid;
      proj = p;
      chat = getActiveChatObj();
    }

    var bubbles = draftBubbles.concat();
    draftBubbles = [];
    renderDraftBubbles();
    updateSendButtonState();
    renderReplyPreview();

    var createdAt = new Date();
    if (window._pendingFiles && window._pendingFiles.length > 0 && bubbles.length > 0) {
      var fileMarkers = window._pendingFiles.map(function(fid) { return '[[FILE:' + fid + ']]'; }).join(' ');
      bubbles[0].text = (bubbles[0].text || '') + ' ' + fileMarkers;
      window._pendingFiles = [];
      renderFileAttachmentPreview();
    }
    var sentMessageIds = [];
    for (var i = 0; i < bubbles.length; i++) {
      var bubble = bubbles[i];
      var msg = createChatMessage({ role: 'user', text: bubble.text, id: AppCore.generateMsgId() }, createdAt);
      if (bubble.replyTo) {
        msg.replyTo = bubble.replyTo;
      }
      chat.messages.push(msg);
      sentMessageIds.push(msg.id);
      chat._messageCount = (chat._messageCount || 0) + 1;
    }

    pendingReply = null;
    renderReplyPreview();

    renderChatMessages();
    updateCurrentProjectLabel();
    renderProjectList();

    var lastText = bubbles[bubbles.length - 1].text;

    var cmd = detectCommand(lastText);
    if (cmd) {
      var typingArea = AppCore.$('chatTypingArea');
      if (cmd.type === 'diary') {
        typingArea.innerHTML = '<div class="typing-indicator">正在偷偷翻日记本……<span class="streaming-cursor">|</span></div>';
      } else if (cmd.type === 'litter') {
        typingArea.innerHTML = '<div class="typing-indicator">正在进入旺财的猫砂盆……<span class="streaming-cursor">|</span></div>';
      } else {
        typingArea.innerHTML = '<div class="typing-indicator">处理命令中……</div>';
      }
      var cmdResult = await executeCommand(cmd, lastText);
      if (cmdResult) {
        AppCore.$('chatTypingArea').innerHTML = '';
        chat.messages.push(createChatMessage({ role: 'system', text: cmd.type === 'diary' ? '在日记里写了点什么' : '猫砂盆好像需要铲一铲', id: AppCore.generateMsgId() }, new Date()));
        chat.messages.push(createChatMessage({ role: 'ai', text: cmdResult, id: AppCore.generateMsgId() }, new Date()));
        renderChatMessages();
        renderProjectList();
        return;
      }
    }

    var diaryIntent = detectDiaryIntent(lastText);

    var typingArea2 = AppCore.$('chatTypingArea');
    if (diaryIntent !== 'none') {
      typingArea2.innerHTML = '<div class="typing-indicator">正在偷偷翻日记本……<span class="streaming-cursor">|</span></div>';
    } else {
      typingArea2.innerHTML = '<div class="typing-indicator">对方正在输入中<span class="streaming-cursor">|</span></div>';
    }

    await triggerAIResponse(chat, lastText, diaryIntent, {
      projectId: proj && proj.id,
      chatId: chat.id,
      currentMessageIds: sentMessageIds
    });
  }

  function shakeInputBar() {
    var el = AppCore.$('chatInput');
    if (!el) return;
    el.classList.add('shake-anim');
    setTimeout(function() { el.classList.remove('shake-anim'); }, 400);
  }

  function openDraftEditor(idx) {
    if (idx < 0 || idx >= draftBubbles.length) return;
    draftEditorIdx = idx;
    AppCore.$('draftEditorIndex').textContent = idx + 1;
    AppCore.$('draftEditorTextarea').value = draftBubbles[idx].text;
    AppCore.$('draftEditorOverlay').classList.add('show');
    setTimeout(function() { AppCore.$('draftEditorTextarea').focus(); }, 350);
  }

  function closeDraftEditor() {
    AppCore.$('draftEditorOverlay').classList.remove('show');
    draftEditorIdx = -1;
  }

  function saveDraftBubble() {
    var text = AppCore.$('draftEditorTextarea').value.trim();
    if (!text) { deleteDraftBubble(); return; }
    if (draftEditorIdx >= 0 && draftEditorIdx < draftBubbles.length) {
      draftBubbles[draftEditorIdx].text = text;
      renderDraftBubbles();
      UIModule.toast('草稿已更新');
    }
    closeDraftEditor();
  }

  function deleteDraftBubble() {
    if (draftEditorIdx >= 0 && draftEditorIdx < draftBubbles.length) {
      draftBubbles.splice(draftEditorIdx, 1);
      renderDraftBubbles();
      updateSendButtonState();
      UIModule.toast('草稿已删除');
    }
    closeDraftEditor();
  }

  // ═══════════════════════════════════════════
  //  Block 13: sendMessage
  // ═══════════════════════════════════════════
  async function sendMessage() {
    var store = AppCore.getStore();
    var input = AppCore.$('chatInput'), text = input.value.trim();

    if (draftBubbles.length > 0 && !text) {
      await sendAllDraftBubbles();
      return;
    }
    if (draftBubbles.length > 0 && text) {
      draftBubbles.push({ text: text });
      input.value = '';
      input.style.height = 'auto';
      renderDraftBubbles();
      updateSendButtonState();
      await sendAllDraftBubbles();
      return;
    }
    if (!text && draftBubbles.length === 0) {
      shakeInputBar();
      return;
    }
    if (!text) return;

    var proj = getActiveProject();
    if (proj && proj.apiConfig && proj.apiConfig.enabled === false) {
      UIModule.toast('请先启用 API');
      return;
    }

    var chat = getActiveChatObj();
    if (!chat) {
      var p = getActiveProject();
      if (!p) {
        var pid = 'p' + AppCore.gid('');
        store.projects.push({ id: pid, name: 'default', preference: '', apiConfig: { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true }, memories: [], chats: [] });
        store.activeProject = pid; p = getActiveProject();
      }
      var cid = 'c' + AppCore.gid('');

      syncProjectMemories(p.id);

      var sortedChats = p.chats.concat().sort(function(a, b) {
        return (b.lastConversationDate || '').localeCompare(a.lastConversationDate || '');
      });
      var prevChat = sortedChats[0];

      var inheritedMsgs = [];
      if (prevChat) {
        inheritedMsgs = prevChat.messages.slice(-12).map(function(m) {
          return {
            role: m.role === 'ai' ? 'ai' : m.role,
            text: m.text || '',
            time: m.time || AppCore.nowTime(),
            date: m.date,
            createdAt: m.createdAt,
            _starred: m._starred || false,
            _isCoreMemory: m._isCoreMemory || false,
            _tokenEstimate: m._tokenEstimate || 0,
            _starredOnce: m._starredOnce || false,
            _inheritedFromWindow: prevChat.id
          };
        });
      }

      if (store._pendingHandoff && store._pendingHandoff.package) {
        var ho = store._pendingHandoff;
        if (ho.recentMessages && ho.recentMessages.length > 0) {
          var hoMsgs = ho.recentMessages.map(function(m) {
            return {
              role: m.role === 'ai' ? 'ai' : m.role,
              text: m.text || '', time: m.time || AppCore.nowTime(),
              date: m.date, createdAt: m.createdAt,
              _starred: m._starred || false, _isCoreMemory: m._isCoreMemory || false,
              _tokenEstimate: m._tokenEstimate || 0, _inheritedFromWindow: 'handoff'
            };
          });
          inheritedMsgs = hoMsgs.concat(inheritedMsgs);
        }
        writeMemoryFile(p.id, cid, ho.package, 'context_handoff_inherited');
        store._pendingHandoff = null;
      }

      var initMessages = [];
      if (inheritedMsgs.length > 0) {
        initMessages.push(createChatMessage({
          role: 'system',
          text: '[继续自上一个窗口的对话，以下是最近的对话记录]',
          _isHandoffNote: true, id: 'msg_' + Date.now().toString(36) + '_sys_h'
        }));
        for (var imi = 0; imi < inheritedMsgs.length; imi++) {
          var im = inheritedMsgs[imi];
          if (!im.id) im.id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
          initMessages.push(im);
        }
      }

      p.chats.push({
        id: cid, name: text.slice(0, 20),
        aiSettings: { autoDateTime: getActiveChatAiSettings().autoDateTime, autoWeather: getActiveChatAiSettings().autoWeather, aiVoice: getActiveChatAiSettings().aiVoice, webSearch: getActiveChatAiSettings().webSearch },
        emailEnabled: false,
        enabledTools: [],
        customPromptRound: 0,
        customPromptStates: {},
        sharedMemoryIds: [], weeklyExports: [], artifacts: [],
        messages: initMessages,
        chatTokens: 0, lastConversationDate: AppCore.fmtDate().iso, lastActiveDate: null, lastInteractionTime: null,
        _messageCount: initMessages.length, _lastSummaryIdx: 0,
        _handoffSuggested: false,
        _sharedMemoryLoaded: true,
        _sharedMemoryLoadedAt: new Date().toISOString()
      });
      store.activeChat = cid; chat = getActiveChatObj();

      flushMemoryFile(p.id, cid, 'context_handoff_inherited');
      console.log('[cold-start] New window initialized with', inheritedMsgs.length, 'inherited messages');
    }
    var userCreatedAt = new Date();
    var userMsg = createChatMessage({ role: 'user', text: text, id: AppCore.generateMsgId() }, userCreatedAt);
    if (pendingReply) {
      userMsg.replyTo = pendingReply.msgId;
      pendingReply = null;
      renderReplyPreview();
    }
    chat.messages.push(userMsg);
    var sentMessageIds = [userMsg.id];
    chat._messageCount = (chat._messageCount || 0) + 1;

    var lastMsg = chat.messages.length >= 2 ? chat.messages[chat.messages.length - 2] : null;
    if (lastMsg && lastMsg._proactive) {
      var ds = getDesireSystem();
      if (ds) {
        if (lastMsg._desireType === 'guardianship') ds.drives.guardianship = Math.max(0, ds.drives.guardianship - 20);
        console.log('[eda] User responded to proactive message, applied response decay');
      }
    }

    input.value = ''; renderChatMessages(); updateCurrentProjectLabel(); renderProjectList();

    chat.lastConversationDate = AppCore.fmtDate().iso;

    var statusMessage = '';
    var cmd = detectCommand(text);
    if (cmd) {
      var typingArea = AppCore.$('chatTypingArea');
      if (cmd.type === 'diary') {
        statusMessage = '正在偷偷翻日记本……';
        typingArea.innerHTML = '<div class="typing-indicator">' + statusMessage + '<span class="streaming-cursor">|</span></div>';
      } else if (cmd.type === 'litter') {
        statusMessage = '正在进入旺财的猫砂盆……';
        typingArea.innerHTML = '<div class="typing-indicator">' + statusMessage + '<span class="streaming-cursor">|</span></div>';
      } else {
        typingArea.innerHTML = '<div class="typing-indicator">处理命令中……</div>';
      }
      var cmdResult = await executeCommand(cmd, text);
      if (cmdResult) {
        typingArea.innerHTML = '';
        var aiAt = new Date();
        if (cmd.type === 'diary') {
          chat.messages.push(createChatMessage({ role: 'system', text: '在日记里写了点什么', id: AppCore.generateMsgId() }, aiAt));
        } else if (cmd.type === 'litter') {
          chat.messages.push(createChatMessage({ role: 'system', text: '猫砂盆好像需要铲一铲', id: AppCore.generateMsgId() }, aiAt));
        }
        chat.messages.push(createChatMessage({ role: 'ai', text: cmdResult, id: AppCore.generateMsgId() }, aiAt));
        chat.lastInteractionTime = new Date().toISOString();
        renderChatMessages();
        renderProjectList();
        return;
      }
    }

    var diaryIntent = detectDiaryIntent(text);

    var typingArea2 = AppCore.$('chatTypingArea');
    if (diaryIntent !== 'none') {
      statusMessage = '正在偷偷翻日记本……';
      typingArea2.innerHTML = '<div class="typing-indicator">' + statusMessage + '<span class="streaming-cursor">|</span></div>';
    } else if (cmd && cmd.type === 'litter') {
      statusMessage = '正在进入旺财的猫砂盆……';
      typingArea2.innerHTML = '<div class="typing-indicator">' + statusMessage + '<span class="streaming-cursor">|</span></div>';
    } else {
      typingArea2.innerHTML = '<div class="typing-indicator">对方正在输入中<span class="streaming-cursor">|</span></div>';
    }

    var sendText = text;
    if (proj && proj._aiStatusChanged) {
      proj._aiStatusChanged = false;
      AppCore.saveStore();
    }
    await triggerAIResponse(chat, sendText, diaryIntent, {
      projectId: proj && proj.id,
      chatId: chat.id,
      currentMessageIds: sentMessageIds,
      replyTo: userMsg.replyTo
    });
  }

  // ═══════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════
  function init() {
    window.openSharedDiary = openSharedDiary;
    // Reset private state
    contextMenuTarget = null;
    batchSelectMode = false;
    batchSelectedIds = [];
    _dynCtxCache = { fp: '', content: '', ts: 0 };
    pendingReply = null;
    draftBubbles = [];
    draftEditorIdx = -1;
    bubbleTouchTimer = null;
    bubbleTouchMsgId = null;
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════
  return {
    init: init,

    // Helpers
    getActiveProject: getActiveProject,
    getProjectById: getProjectById,
    getActiveApiConfig: getActiveApiConfig,
    getActiveChatObj: getActiveChatObj,
    getActiveChatObjForProject: getActiveChatObjForProject,
    getActiveChatAiSettings: getActiveChatAiSettings,
    setActiveModel: setActiveModel,
    newChatDefaults: newChatDefaults,
    updateChatInputEnabledState: updateChatInputEnabledState,

    // Chat rendering
    renderChat: renderChat,
    renderProjectList: renderProjectList,
    selectProject: selectProject,
    selectChat: selectChat,
    addChat: addChat,
    saveChatWithMemories: saveChatWithMemories,
    addProject: addProject,
    saveProject: saveProject,

    // Token estimation & context
    estimateTokens: estimateTokens,
    detectRecallIntent: detectRecallIntent,
    buildRetrievalBlock: buildRetrievalBlock,
    queueEvictedMessageWrite: queueEvictedMessageWrite,
    triggerWindowHandoff: triggerWindowHandoff,
    buildSystemPrompt: buildSystemPrompt,
    buildDynamicContextBlock: buildDynamicContextBlock,
    buildRecentMsgIdBlock: buildRecentMsgIdBlock,
    buildCodexPromptContext: buildCodexPromptContext,
    getChatForContext: getChatForContext,
    getSystemPromptStatic: function() { return SYSTEM_PROMPT_STATIC; },
    commitCodexResponse: commitCodexResponse,
    invalidateDynamicContext: invalidateDynamicContext,

    // Self-reflection
    extractReflection: extractReflection,
    parseReflectionFallback: parseReflectionFallback,
    extractMemoryMarker: extractMemoryMarker,
    extractTodosFromResponse: extractTodosFromResponse,
    processReflection: processReflection,
    updateAffectGraph: updateAffectGraph,
    getRecentAffectLabels: getRecentAffectLabels,
    getRecentUserAffectLabels: getRecentUserAffectLabels,

    // Commands
    detectCommand: detectCommand,
    executeCommand: executeCommand,

    // Context menu & project/chat management
    showContextMenu: showContextMenu,
    hideContextMenu: hideContextMenu,
    confirmDeleteProject: confirmDeleteProject,
    execDeleteProject: execDeleteProject,
    confirmDeleteChat: confirmDeleteChat,
    execDeleteChat: execDeleteChat,
    showPreferenceModal: showPreferenceModal,
    savePreference: savePreference,
    showAiNameModal: showAiNameModal,
    saveAiName: saveAiName,
    navigateToDiaryReplySource: navigateToDiaryReplySource,
    updateCurrentProjectLabel: updateCurrentProjectLabel,
    editProjectName: editProjectName,
    confirmDeleteProjectFromEdit: confirmDeleteProjectFromEdit,
    saveEditedProjectName: saveEditedProjectName,
    editChatName: editChatName,
    confirmDeleteChatFromEdit: confirmDeleteChatFromEdit,
    saveEditedChatName: saveEditedChatName,

    // Sanitize
    sanitizeDisplayText: sanitizeDisplayText,
    sanitizeProactiveMessage: sanitizeProactiveMessage,

    // Tool call panel
    renderToolCallPanel: renderToolCallPanel,
    toggleToolCallPanel: toggleToolCallPanel,
    showToolCallDetail: showToolCallDetail,

    // Chat messages & rendering
    renderChatMessages: renderChatMessages,
    renderReplyBlock: renderReplyBlock,
    scrollToMsg: scrollToMsg,
    startReply: startReply,
    cancelReply: cancelReply,
    renderReplyPreview: renderReplyPreview,
    bubbleTouchStart: bubbleTouchStart,
    bubbleTouchEnd: bubbleTouchEnd,
    bubbleTouchMove: bubbleTouchMove,
    handleBubbleClick: handleBubbleClick,
    handleBubbleLongPress: handleBubbleLongPress,
    handleOuterStarClick: handleOuterStarClick,
    enterBatchSelectMode: enterBatchSelectMode,
    toggleBatchSelect: toggleBatchSelect,
    exitBatchSelectMode: exitBatchSelectMode,
    confirmBatchStar: confirmBatchStar,
    executeBatchStar: executeBatchStar,
    createUserStarredMemory: createUserStarredMemory,

    // Bubble actions
    toggleBubbleActions: toggleBubbleActions,
    playTTS: playTTS,
    copyBubble: copyBubble,
    deleteBubble: deleteBubble,
    starBubble: starBubble,
    splitSentences: splitSentences,
    displaySentences: displaySentences,
    parseAIBubbles: parseAIBubbles,
    displayAIBubbles: displayAIBubbles,

    // AI response
    triggerAIResponse: triggerAIResponse,

    // Draft system
    stageDraftBubble: stageDraftBubble,
    renderDraftBubbles: renderDraftBubbles,
    updateSendButtonState: updateSendButtonState,
    toggleMoreMenu: toggleMoreMenu,
    closeMoreMenuOnClick: closeMoreMenuOnClick,
    closeMoreMenu: closeMoreMenu,
    openPokeSettings: openPokeSettings,
    savePokeSettings: savePokeSettings,
    handleAIAvatarDblClick: handleAIAvatarDblClick,
    sendAllDraftBubbles: sendAllDraftBubbles,
    shakeInputBar: shakeInputBar,
    openDraftEditor: openDraftEditor,
    closeDraftEditor: closeDraftEditor,
    saveDraftBubble: saveDraftBubble,
    deleteDraftBubble: deleteDraftBubble,

    // Send message
    sendMessage: sendMessage,

  };
})();

AppCore.register('chat', ChatModule);
