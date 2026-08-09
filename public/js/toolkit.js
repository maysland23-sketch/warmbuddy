/**
 * WarmBuddy Toolkit Module
 * ── MCP tool definitions, per-window tool enable/disable, auth config ──
 */

var ToolkitModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Private: generate unique ID
  // ═══════════════════════════════════════════

  function generateId() {
    return 'tool_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ═══════════════════════════════════════════
  //  Private: mask a token for display
  // ═══════════════════════════════════════════

  function maskToken(token) {
    if (!token || token.length <= 8) return '****';
    return token.slice(0, 4) + '...' + token.slice(-4);
  }

  // ═══════════════════════════════════════════
  //  Public: get all tool definitions
  // ═══════════════════════════════════════════

  function getDefinitions() {
    var store = AppCore.getStore();
    if (!store._toolDefinitions) store._toolDefinitions = [];
    return store._toolDefinitions;
  }

  // ═══════════════════════════════════════════
  //  Public: add a tool definition
  // ═══════════════════════════════════════════

  function addDefinition(def) {
    var store = AppCore.getStore();
    if (!store._toolDefinitions) store._toolDefinitions = [];
    var newDef = {
      id: generateId(),
      name: def.name || 'Untitled Tool',
      transport: def.transport || 'streamable-http',
      url: def.url || '',
      description: def.description || '',
      createdAt: new Date().toISOString(),
      auth: def.auth || { type: 'none' }
    };
    store._toolDefinitions.push(newDef);
    AppCore.saveStore();
    syncToBackend();
    return newDef;
  }

  // ═══════════════════════════════════════════
  //  Public: remove a tool definition
  // ═══════════════════════════════════════════

  function removeDefinition(id) {
    var store = AppCore.getStore();
    if (!store._toolDefinitions) return;
    store._toolDefinitions = store._toolDefinitions.filter(function(d) { return d.id !== id; });
    // Also remove from all chats' enabledTools
    (store.projects || []).forEach(function(p) {
      (p.chats || []).forEach(function(c) {
        if (c.enabledTools) {
          c.enabledTools = c.enabledTools.filter(function(tid) { return tid !== id; });
        }
      });
    });
    AppCore.saveStore();
    syncToBackend();
  }

  // ═══════════════════════════════════════════
  //  Public: get enabled tool IDs for a chat
  // ═══════════════════════════════════════════

  function getEnabledTools(chatId) {
    var store = AppCore.getStore();
    var found = null;
    (store.projects || []).forEach(function(p) {
      (p.chats || []).forEach(function(c) {
        if (c.id === chatId) found = c;
      });
    });
    if (!found) return [];
    return found.enabledTools || [];
  }

  // ═══════════════════════════════════════════
  //  Public: toggle a tool for a chat window
  // ═══════════════════════════════════════════

  function toggleTool(chatId, toolId, enabled) {
    var store = AppCore.getStore();
    var found = null;
    var foundProjectId = null;
    (store.projects || []).forEach(function(p) {
      (p.chats || []).forEach(function(c) {
        if (c.id === chatId) { found = c; foundProjectId = p.id; }
      });
    });
    if (!found) return;
    if (!found.enabledTools) found.enabledTools = [];
    if (enabled) {
      if (found.enabledTools.indexOf(toolId) < 0) found.enabledTools.push(toolId);
    } else {
      found.enabledTools = found.enabledTools.filter(function(t) { return t !== toolId; });
    }
    AppCore.saveStore();
    // Sync window tools to backend for cross-device persistence
    syncWindowTools(foundProjectId);
  }

  // ═══════════════════════════════════════════
  //  Private: sync window tool states to backend
  // ═══════════════════════════════════════════

  function syncWindowTools(projectId) {
    if (!projectId) return;
    var store = AppCore.getStore();
    var proj = (store.projects || []).find(function(p) { return p.id === projectId; });
    if (!proj) return;
    // Build _windowTools map: { chatId: [enabledToolId, ...] }
    var windowTools = {};
    (proj.chats || []).forEach(function(c) {
      if (c.enabledTools && c.enabledTools.length > 0) {
        windowTools[c.id] = c.enabledTools.slice();
      }
    });
    fetch(AppCore.BACKEND_URL + '/api/toolkit/window-tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectId, windowTools: windowTools })
    }).catch(function(err) {
      console.warn('[ToolkitModule] window-tools sync failed:', err.message);
    });
  }

  // ═══════════════════════════════════════════
  //  Private: sync tool definitions to backend
  // ═══════════════════════════════════════════

  function syncToBackend() {
    var store = AppCore.getStore();
    fetch(AppCore.BACKEND_URL + '/api/toolkit/definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitions: store._toolDefinitions || [] })
    }).catch(function(err) {
      console.warn('[ToolkitModule] sync failed:', err.message);
    });
  }

  // ═══════════════════════════════════════════
  //  Public: show add-tool modal
  // ═══════════════════════════════════════════

  function showAddToolModal() {
    UIModule.showModal('添加工具',
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">名称</label>' +
        '<input class="modal-input" id="toolName" placeholder="工具名称" maxlength="50">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">传输类型</label>' +
        '<select class="modal-input" id="toolTransport" style="appearance:auto;">' +
          '<option value="streamable-http">streamable-http</option>' +
          '<option value="sse">sse</option>' +
          '<option value="stdio">stdio</option>' +
        '</select>' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">服务器地址</label>' +
        '<input class="modal-input" id="toolUrl" placeholder="https://example.com/mcp" maxlength="500">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">鉴权类型</label>' +
        '<select class="modal-input" id="toolAuthType" style="appearance:auto;" onchange="var v=this.value;var g=document.getElementById(\'toolAuthGroup\');if(g)g.style.display=v===\'none\'?\'none\':\'block\';">' +
          '<option value="none">无鉴权</option>' +
          '<option value="bearer">Bearer Token</option>' +
          '<option value="basic">Basic Auth</option>' +
        '</select>' +
      '</div>' +
      '<div id="toolAuthGroup" style="margin-bottom:10px;display:none;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">鉴权值</label>' +
        '<input class="modal-input" id="toolAuthToken" placeholder="Token 或 user:pass" maxlength="500" type="password" autocomplete="off">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">描述</label>' +
        '<input class="modal-input" id="toolDesc" placeholder="可选描述" maxlength="200">' +
      '</div>',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: saveAddTool }]);
  }

  // ═══════════════════════════════════════════
  //  Private: save new tool from modal
  // ═══════════════════════════════════════════

  function saveAddTool() {
    var name = (AppCore.$('toolName') && AppCore.$('toolName').value || '').trim();
    var transport = AppCore.$('toolTransport') && AppCore.$('toolTransport').value || 'streamable-http';
    var url = (AppCore.$('toolUrl') && AppCore.$('toolUrl').value || '').trim();
    var authType = AppCore.$('toolAuthType') && AppCore.$('toolAuthType').value || 'none';
    var authToken = (AppCore.$('toolAuthToken') && AppCore.$('toolAuthToken').value || '').trim();
    var description = (AppCore.$('toolDesc') && AppCore.$('toolDesc').value || '').trim();
    if (!name) { UIModule.toast('请输入工具名称'); return; }
    if (!url) { UIModule.toast('请输入服务器地址'); return; }
    if (authType !== 'none' && !authToken) { UIModule.toast('请输入鉴权值'); return; }
    var def = { name: name, transport: transport, url: url, description: description };
    if (authType !== 'none') {
      def.auth = { type: authType, token: authToken };
    } else {
      def.auth = { type: 'none' };
    }
    addDefinition(def);
    UIModule.closeModal();
    renderToolkitList();
    UIModule.toast('工具已添加');
  }

  // ═══════════════════════════════════════════
  //  Private: edit tool definition
  // ═══════════════════════════════════════════

  function editToolDef(id) {
    var definitions = getDefinitions();
    var def = definitions.find(function(d) { return d.id === id; });
    if (!def) { UIModule.toast('工具定义未找到'); return; }
    var authCfg = def.auth || { type: 'none' };
    var authType = authCfg.type || 'none';
    var authToken = authCfg.token || '';
    UIModule.showModal('编辑工具',
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">名称</label>' +
        '<input class="modal-input" id="toolName" placeholder="工具名称" maxlength="50" value="' + AppCore.escapeHtml(def.name).replace(/"/g, '&quot;') + '">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">传输类型</label>' +
        '<select class="modal-input" id="toolTransport" style="appearance:auto;">' +
          '<option value="streamable-http"' + (def.transport === 'streamable-http' ? ' selected' : '') + '>streamable-http</option>' +
          '<option value="sse"' + (def.transport === 'sse' ? ' selected' : '') + '>sse</option>' +
          '<option value="stdio"' + (def.transport === 'stdio' ? ' selected' : '') + '>stdio</option>' +
        '</select>' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">服务器地址</label>' +
        '<input class="modal-input" id="toolUrl" placeholder="https://example.com/mcp" maxlength="500" value="' + AppCore.escapeHtml(def.url || '').replace(/"/g, '&quot;') + '">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">鉴权类型</label>' +
        '<select class="modal-input" id="toolAuthType" style="appearance:auto;" onchange="var v=this.value;var g=document.getElementById(\'toolAuthGroup\');if(g)g.style.display=v===\'none\'?\'none\':\'block\';">' +
          '<option value="none"' + (authType === 'none' ? ' selected' : '') + '>无鉴权</option>' +
          '<option value="bearer"' + (authType === 'bearer' ? ' selected' : '') + '>Bearer Token</option>' +
          '<option value="basic"' + (authType === 'basic' ? ' selected' : '') + '>Basic Auth</option>' +
        '</select>' +
      '</div>' +
      '<div id="toolAuthGroup" style="margin-bottom:10px;' + (authType === 'none' ? 'display:none;' : '') + '">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">鉴权值</label>' +
        '<input class="modal-input" id="toolAuthToken" placeholder="Token 或 user:pass" maxlength="500" type="password" autocomplete="off" value="' + AppCore.escapeHtml(authToken).replace(/"/g, '&quot;') + '">' +
      '</div>' +
      '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-lighter);margin-bottom:4px;letter-spacing:0.03em;">描述</label>' +
        '<input class="modal-input" id="toolDesc" placeholder="可选描述" maxlength="200" value="' + AppCore.escapeHtml(def.description || '').replace(/"/g, '&quot;') + '">' +
      '</div>' +
      '<input type="hidden" id="editToolId" value="' + id + '">',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'delete', cls: 'danger', onclick: confirmDeleteToolDef },
       { label: 'save', cls: 'confirm', onclick: saveEditTool }]);
  }

  // ═══════════════════════════════════════════
  //  Private: save edited tool
  // ═══════════════════════════════════════════

  function saveEditTool() {
    var id = AppCore.$('editToolId') && AppCore.$('editToolId').value || '';
    if (!id) { UIModule.toast('编辑失败：缺少工具ID'); return; }
    var name = (AppCore.$('toolName') && AppCore.$('toolName').value || '').trim();
    var transport = AppCore.$('toolTransport') && AppCore.$('toolTransport').value || 'streamable-http';
    var url = (AppCore.$('toolUrl') && AppCore.$('toolUrl').value || '').trim();
    var authType = AppCore.$('toolAuthType') && AppCore.$('toolAuthType').value || 'none';
    var authToken = (AppCore.$('toolAuthToken') && AppCore.$('toolAuthToken').value || '').trim();
    var description = (AppCore.$('toolDesc') && AppCore.$('toolDesc').value || '').trim();
    if (!name) { UIModule.toast('请输入工具名称'); return; }
    if (!url) { UIModule.toast('请输入服务器地址'); return; }
    if (authType !== 'none' && !authToken) { UIModule.toast('请输入鉴权值'); return; }

    var store = AppCore.getStore();
    if (!store._toolDefinitions) store._toolDefinitions = [];
    var idx = -1;
    for (var i = 0; i < store._toolDefinitions.length; i++) {
      if (store._toolDefinitions[i].id === id) { idx = i; break; }
    }
    if (idx === -1) { UIModule.toast('工具定义未找到'); return; }

    store._toolDefinitions[idx].name = name;
    store._toolDefinitions[idx].transport = transport;
    store._toolDefinitions[idx].url = url;
    store._toolDefinitions[idx].description = description;
    store._toolDefinitions[idx].auth = authType !== 'none' ? { type: authType, token: authToken } : { type: 'none' };

    AppCore.saveStore();
    syncToBackend();
    UIModule.closeModal();
    renderToolkitList();
    UIModule.toast('工具已更新');
  }

  // ═══════════════════════════════════════════
  //  Private: confirm and delete tool from edit modal
  // ═══════════════════════════════════════════

  function confirmDeleteToolDef() {
    var id = AppCore.$('editToolId') && AppCore.$('editToolId').value || '';
    if (!id) return;
    if (confirm('确定删除此工具定义？所有窗口中该工具的启用状态将被清除。')) {
      removeDefinition(id);
      UIModule.closeModal();
      renderToolkitList();
    }
  }

  // ═══════════════════════════════════════════
  //  Public: show window tools modal
  // ═══════════════════════════════════════════

  function showWindowToolsModal() {
    var chat = AppCore.getActiveChatObj();
    if (!chat) { UIModule.toast('请先打开一个对话'); return; }
    var definitions = getDefinitions();
    var enabled = chat.enabledTools || [];

    if (definitions.length === 0) {
      UIModule.showModal('窗口工具',
        '<p style="font-size:12px;color:var(--text-lighter);line-height:1.6;">暂无可用工具。<br>请先在 Settings 面板的 Toolkit 区域添加 MCP 工具定义。</p>',
        [{ label: 'close', cls: 'cancel', onclick: UIModule.closeModal }]);
      return;
    }

    var listHtml = definitions.map(function(def) {
      var isOn = enabled.indexOf(def.id) >= 0;
      return '<div class="settings-item" style="cursor:pointer;" data-action="toggleWindowTool" data-args="' + chat.id + '|' + def.id + '|' + (!isOn) + '">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + AppCore.escapeHtml(def.name) + '</div>' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-top:1px;">' + AppCore.escapeHtml(def.url) + '</div>' +
        '</div>' +
        '<div class="toggle-switch' + (isOn ? ' on' : '') + '" style="margin-left:12px;"></div>' +
      '</div>';
    }).join('');

    UIModule.showModal('窗口工具',
      '<p style="font-size:11px;color:var(--text-lighter);margin-bottom:10px;line-height:1.5;">为当前窗口启用或禁用工具。仅影响此对话窗口。</p>' +
      listHtml,
      [{ label: 'close', cls: 'cancel', onclick: UIModule.closeModal }]);
  }

  // ═══════════════════════════════════════════
  //  Public: render toolkit list in settings panel
  // ═══════════════════════════════════════════

  function renderToolkitList() {
    var container = AppCore.$('toolkitList');
    if (!container) return;
    var definitions = getDefinitions();
    if (definitions.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-lighter);padding:6px 0;">暂无工具定义</div>';
      return;
    }
    container.innerHTML = definitions.map(function(def) {
      var authCfg = def.auth || { type: 'none' };
      var authLabel = authCfg.type === 'bearer' ? 'Bearer ' + maskToken(authCfg.token || '')
        : authCfg.type === 'basic' ? 'Basic ' + maskToken(authCfg.token || '')
        : '';
      var authHtml = authLabel ? '<span style="color:var(--text-lighter);"> &middot; ' + AppCore.escapeHtml(authLabel) + '</span>' : '';
      return '<div class="settings-item" style="cursor:default;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + AppCore.escapeHtml(def.name) + '</div>' +
          '<div style="font-size:10px;color:var(--text-lighter);margin-top:2px;">' + AppCore.escapeHtml(def.transport) + ' &middot; ' + AppCore.escapeHtml(def.url) + authHtml + '</div>' +
        '</div>' +
        '<span style="font-size:12px;color:var(--text-lighter);cursor:pointer;padding:2px 6px;flex-shrink:0;opacity:0.6;transition:opacity 0.2s;" ' +
          'data-action="editToolDef" data-args="' + def.id + '" title="编辑工具"' +
          'onmouseenter="this.style.opacity=\'1\'" onmouseleave="this.style.opacity=\'0.6\'">✎</span>' +
      '</div>';
    }).join('');
  }

  // ═══════════════════════════════════════════
  //  Init — load from server, event delegation
  // ═══════════════════════════════════════════

  function init() {
    var store = AppCore.getStore();
    if (!store._toolDefinitions) store._toolDefinitions = [];

    // Load tool definitions from server on startup (merge — server wins for same ID)
    fetch(AppCore.BACKEND_URL + '/api/toolkit/definitions')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.definitions && data.definitions.length > 0) {
          var localMap = {};
          store._toolDefinitions.forEach(function(d) { localMap[d.id] = d; });
          data.definitions.forEach(function(sd) {
            localMap[sd.id] = sd;
          });
          store._toolDefinitions = Object.values(localMap);
          AppCore.saveStore();
          console.log('[ToolkitModule] Loaded ' + data.definitions.length + ' definitions from server');
          // Re-render if settings panel is open
          renderToolkitList();
        }
      })
      .catch(function() { /* server unavailable, use local */ });

    document.addEventListener('click', function(event) {
      var target = event.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      var args = target.getAttribute('data-args') || '';

      switch (action) {
        case 'showAddToolModal':
          showAddToolModal();
          break;
        case 'removeToolDef':
          if (confirm('确定删除此工具定义？所有窗口中该工具的启用状态将被清除。')) {
            removeDefinition(args);
            renderToolkitList();
          }
          break;
        case 'editToolDef':
          editToolDef(args);
          break;
        case 'showWindowToolsModal':
          showWindowToolsModal();
          break;
        case 'toggleWindowTool':
          var parts = args.split('|');
          if (parts.length >= 3) {
            var chatId = parts[0];
            var toolId = parts[1];
            var enabled = parts[2] === 'true';
            toggleTool(chatId, toolId, enabled);
            // Re-render the modal with updated state
            showWindowToolsModal();
          }
          break;
      }
    });

    console.log('[ToolkitModule] initialized');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,
    getDefinitions: getDefinitions,
    addDefinition: addDefinition,
    removeDefinition: removeDefinition,
    getEnabledTools: getEnabledTools,
    toggleTool: toggleTool,
    showAddToolModal: showAddToolModal,
    showWindowToolsModal: showWindowToolsModal,
    renderToolkitList: renderToolkitList
  };
})();

AppCore.register('toolkit', ToolkitModule);
