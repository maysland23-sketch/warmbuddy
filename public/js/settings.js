/**
 * WarmBuddy SettingsModule v1.0
 * ── API configuration, provider presets, model selection, email, theme toggles ──
 */

var SettingsModule = (function() {
  'use strict';

  var PROVIDER_NAMES = { deepseek: '🔷 DeepSeek', anthropic: '🟠 Anthropic', openai: '🟢 OpenRouter' };
  var FORMAT_NAMES = { openai: 'OpenAI 格式', anthropic: 'Anthropic 格式' };

  var fallbackPresets = [
    { id: 'deepseek-openai', label: 'DeepSeek (OpenAI 格式)', endpoint: 'https://api.deepseek.com/v1/chat/completions', provider: 'deepseek', format: 'openai', models: ['deepseek-chat','deepseek-v4-pro','deepseek-v4-flash','deepseek-reasoner'] },
    { id: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', provider: 'openrouter', format: 'openai', models: ['openai/gpt-4o','anthropic/claude-sonnet-4-6','google/gemini-2.5-pro','deepseek/deepseek-chat','meta-llama/llama-4-maverick'] },
    { id: 'glm', label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', provider: 'glm', format: 'openai', models: ['glm-4-plus','glm-4-flash','glm-4','glm-4-air'] },
    { id: 'anthropic', label: 'Anthropic 原生', endpoint: 'https://api.anthropic.com/v1/messages', provider: 'anthropic', format: 'anthropic', models: ['claude-sonnet-4-6','claude-opus-4-8','claude-haiku-4-5'] },
    { id: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', provider: 'openai', format: 'openai', models: ['gpt-4o','gpt-4o-mini','gpt-4-turbo'] }
  ];

  async function loadPresets() {
    var store = AppCore.getStore();
    try {
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 5000);
      var resp = await fetch(AppCore.BACKEND_URL + '/api/presets', { signal: controller.signal });
      clearTimeout(timeout);
      var data = await resp.json();
      store.providerPresets = data.presets && data.presets.length > 0 ? data.presets : fallbackPresets;
      if (data.models) {
        var modelList = Array.isArray(data.models) ? data.models : Object.values(data.models);
        for (var mi = 0; mi < modelList.length; mi++) {
          if (!store.availableModels.find(function(x) { return x.id === modelList[mi].id; })) {
            store.availableModels.push(modelList[mi]);
          }
        }
      }
    } catch (e) {
      console.warn('[presets] Remote unavailable, using offline fallback:', e.message);
      store.providerPresets = fallbackPresets;
    }
    if (!store.selectedPreset && store.providerPresets.length > 0) {
      store.selectedPreset = store.providerPresets[0].id;
      store.apiEndpoint = store.providerPresets[0].endpoint;
    }
  }

  function selectPreset(presetId) {
    var store = AppCore.getStore();
    var preset = store.providerPresets.find(function(p) { return p.id === presetId; });
    if (!preset) return;
    store.selectedPreset = presetId;
    store.apiEndpoint = preset.endpoint;
    var ei = AppCore.$('apiEndpointInput');
    if (ei) ei.value = preset.endpoint;
    if (preset.models && preset.models.length > 0) {
      var proj = AppCore.getActiveProject();
      var currentModel = (proj && proj.apiConfig && proj.apiConfig.model) || 'deepseek-chat';
      if (preset.models.indexOf(currentModel) === -1) {
        if (proj) { if (!proj.apiConfig) proj.apiConfig = {}; proj.apiConfig.model = preset.models[0]; }
        var mv = AppCore.$('modelVal');
        if (mv) mv.textContent = preset.models[0];
      }
    }
    UIModule.toast('Provider: ' + preset.label);
  }

  function showApiModal() {
    var store = AppCore.getStore();
    var presets = store.providerPresets;
    var presetHtml = presets.length > 0 ?
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' +
        presets.map(function(p) {
          return '<button class="preset-chip' + (p.id === store.selectedPreset ? ' active' : '') + '" onclick="selectPreset(\'' + p.id + '\')" style="padding:6px 12px;border-radius:16px;border:1px solid ' + (p.id === store.selectedPreset ? 'var(--accent)' : 'var(--border)') + ';background:' + (p.id === store.selectedPreset ? 'var(--accent-pale)' : 'var(--bg-card)') + ';font-size:12px;cursor:pointer;color:var(--text);transition:all 0.2s;">' + p.label + '</button>';
        }).join('') +
      '</div>'
      : '<div style="font-size:12px;color:var(--text-lighter);margin-bottom:8px;">Loading presets...</div>';
    var providerInfo = store.connectionStatus
      ? '<div style="font-size:11px;color:var(--text-lighter);margin-bottom:4px;">Provider: ' + (store.connectionStatus.provider || '?') + ' · Format: ' + (store.connectionStatus.format || '?') + '</div>'
      : '';
    var statusHtml = store.connectionStatus && store.connectionStatus !== 'testing'
      ? '<div class="conn-status ' + (store.connectionStatus.success ? 'success' : 'error') + '">' + (store.connectionStatus.success ? '✅ Connected' : '❌ Failed') + ': ' + store.connectionStatus.message + '</div>'
      : (store.connectionStatus === 'testing' ? '<div class="conn-status testing">⏳ Testing...</div>' : '');
    UIModule.showModal('API Configuration',
      '<div style="font-size:12px;color:var(--text-lighter);margin-bottom:6px;letter-spacing:0.03em;">🔌 选择 API 提供商</div>' +
      presetHtml +
      '<input class="modal-input" id="apiKeyInput" placeholder="Enter API Key" value="' + store.apiKey + '" type="password" autocomplete="off">' +
      '<input class="modal-input" id="apiEndpointInput" placeholder="API Endpoint" value="' + store.apiEndpoint + '">' +
      providerInfo + statusHtml +
      '<button class="test-conn-btn" id="testConnBtn" onclick="testConnection()">Test Connection</button>',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: saveApiConfig }]);
  }

  function saveApiConfig() {
    var store = AppCore.getStore();
    store.apiKey = AppCore.$('apiKeyInput').value;
    store.apiEndpoint = AppCore.$('apiEndpointInput').value;
    var matchedPreset = store.providerPresets.find(function(p) { return p.endpoint === store.apiEndpoint; });
    store.selectedPreset = matchedPreset ? matchedPreset.id : null;
    var ac2 = AppCore.getActiveApiConfig();
    var aks = AppCore.$('apiKeyStatus');
    if (aks) aks.textContent = ac2.apiKey ? '●●●●●●●●' + ac2.apiKey.slice(-4) : '●●●●●●●●';
    var aev = AppCore.$('apiEndpointVal');
    if (aev) aev.textContent = ac2.model || 'not set';
    AppCore.saveStore();
    store._importing = true;
    UIModule.closeModal();
    UIModule.toast('API config saved');
    if (typeof syncProjectConfigToBackend === 'function') syncProjectConfigToBackend();
  }

  function showProjectApiModal(pid) {
    var store = AppCore.getStore();
    var proj = AppCore.getProjectById(pid) || AppCore.getActiveProject();
    if (!proj) return;
    var ac = proj.apiConfig || { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true };
    var presets = store.providerPresets;
    var presetHtml = presets.length > 0 ? presets.map(function(p) {
      return '<button class="preset-chip' + (p.endpoint === ac.endpoint ? ' active' : '') + '" onclick="document.getElementById(\'pjApiEndpoint\').value=\'' + p.endpoint + '\';document.getElementById(\'pjApiModel\').value=\'' + (p.models && p.models[0] ? p.models[0] : ac.model) + '\';document.querySelectorAll(\'.preset-chip\').forEach(function(b){b.classList.remove(\'active\');});event.target.classList.add(\'active\');" style="padding:4px 10px;border-radius:14px;border:1px solid ' + (p.endpoint === ac.endpoint ? 'var(--accent)' : 'var(--border)') + ';background:' + (p.endpoint === ac.endpoint ? 'var(--accent-pale)' : 'var(--bg-card)') + ';font-size:11px;cursor:pointer;color:var(--text);margin:2px;">' + p.label + '</button>';
    }).join('') : '';
    UIModule.showModal('Project API — ' + proj.name,
      '<div style="font-size:11px;color:var(--text-lighter);margin-bottom:4px;">为 "' + proj.name + '" 配置独立的 API 连接</div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">' + presetHtml + '</div>' +
      '<input class="modal-input" id="pjApiKey" placeholder="API Key" value="' + (ac.apiKey || '') + '" type="password" autocomplete="off">' +
      '<input class="modal-input" id="pjApiEndpoint" placeholder="Endpoint" value="' + (ac.endpoint || '') + '">' +
      '<input class="modal-input" id="pjApiModel" placeholder="Model ID" value="' + (ac.model || 'deepseek-chat') + '">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">' +
      '<span style="font-size:12px;color:var(--text-light);">启用</span>' +
      '<div class="toggle-switch' + (ac.enabled !== false ? ' on' : '') + '" id="pjApiEnabled" onclick="this.classList.toggle(\'on\')"></div>' +
      '</div>' +
      '<button class="test-conn-btn" onclick="testProjectConnection(\'' + proj.id + '\')" style="margin-top:8px;">测试连接</button>',
      [{ label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
       { label: 'save', cls: 'confirm', onclick: function() { saveProjectApiConfig(proj.id); } }]);
  }

  function saveProjectApiConfig(pid) {
    var store = AppCore.getStore();
    var proj = AppCore.getProjectById(pid);
    if (!proj) return;
    if (!proj.apiConfig) proj.apiConfig = { apiKey: '', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', enabled: true };
    proj.apiConfig.apiKey = (document.getElementById('pjApiKey') && document.getElementById('pjApiKey').value) || '';
    proj.apiConfig.endpoint = (document.getElementById('pjApiEndpoint') && document.getElementById('pjApiEndpoint').value) || 'https://api.deepseek.com/v1/chat/completions';
    proj.apiConfig.model = (document.getElementById('pjApiModel') && document.getElementById('pjApiModel').value) || 'deepseek-chat';
    proj.apiConfig.enabled = document.getElementById('pjApiEnabled') ? document.getElementById('pjApiEnabled').classList.contains('on') !== false : true;
    AppCore.saveStore();
    store._importing = true;
    UIModule.closeModal();
    if (typeof renderProjectList === 'function') renderProjectList();
    updateSettingsUI();
    if (typeof syncProjectConfigToBackend === 'function') syncProjectConfigToBackend();
    if (typeof updateChatInputEnabledState === 'function') updateChatInputEnabledState();
    UIModule.toast('✅ ' + proj.name + ' API 配置已保存');
  }

  async function testProjectConnection(pid) {
    var apiKey = (document.getElementById('pjApiKey') && document.getElementById('pjApiKey').value || '').trim();
    var endpoint = (document.getElementById('pjApiEndpoint') && document.getElementById('pjApiEndpoint').value || '').trim();
    var model = (document.getElementById('pjApiModel') && document.getElementById('pjApiModel').value || '').trim() || 'deepseek-chat';
    if (!apiKey) { UIModule.toast('请先输入 API Key'); return; }
    if (!endpoint) { UIModule.toast('请先输入 Endpoint'); return; }
    UIModule.toast('⏳ 测试连接中...');
    try {
      var resp = await fetch(AppCore.BACKEND_URL + '/api/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey, endpoint: endpoint, model: model, projectId: pid })
      });
      var data = await resp.json();
      if (data.success) {
        UIModule.toast('✅ 连接成功 — ' + data.provider + ' (' + (data.models || []).length + ' models)');
      } else {
        UIModule.toast('❌ 连接失败: ' + (data.message || 'unknown error'));
      }
    } catch (e) {
      UIModule.toast('❌ 网络错误: ' + e.message);
    }
  }

  async function testConnection() {
    var store = AppCore.getStore();
    var apiKey = AppCore.$('apiKeyInput').value.trim();
    var endpoint = AppCore.$('apiEndpointInput').value.trim();
    var proj = AppCore.getActiveProject();
    var model = (proj && proj.apiConfig && proj.apiConfig.model) || (store.aiSettings && store.aiSettings.model) || 'deepseek-chat';
    if (!apiKey) { UIModule.toast('Please enter an API key first'); return; }
    store.apiKey = apiKey;
    store.apiEndpoint = endpoint;
    AppCore.saveStore();
    var btn = AppCore.$('testConnBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '⏳ Testing...';
    store.connectionStatus = 'testing';
    try {
      var response = await fetch(AppCore.BACKEND_URL + '/api/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey, endpoint: endpoint, model: model })
      });
      var data = await response.json();
      store.connectionStatus = data;
      if (data.success && data.models && data.models.length > 0) {
        store.availableModels = data.models;
        var proj2 = AppCore.getActiveProject();
        var currentModel = (proj2 && proj2.apiConfig && proj2.apiConfig.model) || 'deepseek-chat';
        var currentExists = data.models.find(function(m) { return m.id === currentModel; });
        if (!currentExists && data.models.length > 0) {
          if (proj2) { if (!proj2.apiConfig) proj2.apiConfig = {}; proj2.apiConfig.model = data.models[0].id; }
        }
      }
      btn.textContent = data.success ? '✅ Connected! Test Again' : '❌ Failed — Try Again';
      btn.disabled = false;
      updateSettingsUI();
      UIModule.toast(data.success ? 'Connection successful!' : 'Connection failed: ' + data.message);
    } catch (err) {
      store.connectionStatus = { success: false, provider: null, message: 'Network error: ' + err.message };
      btn.textContent = '❌ Error — Try Again';
      btn.disabled = false;
      UIModule.toast('Network error');
    }
    showApiModal();
  }

  async function fetchModelsFromAPI() {
    var store = AppCore.getStore();
    var cfg = AppCore.getActiveApiConfig();
    if (!cfg.apiKey) { UIModule.toast('Please configure API key first'); return; }
    try {
      var response = await fetch(AppCore.BACKEND_URL + '/api/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cfg.apiKey, endpoint: cfg.endpoint })
      });
      var data = await response.json();
      if (data.success && data.models && data.models.length > 0) {
        store.availableModels = data.models;
        UIModule.toast('Loaded ' + data.models.length + ' models from ' + data.provider);
        showModelModal();
      }
    } catch (err) {
      UIModule.toast('Failed to fetch models');
    }
  }

  function showModelModal() {
    var store = AppCore.getStore();
    var models = store.availableModels;
    var groups = {};
    for (var i = 0; i < models.length; i++) {
      var p = models[i].provider || 'unknown';
      if (!groups[p]) groups[p] = [];
      groups[p].push(models[i]);
    }
    var hasConnection = store.connectionStatus && store.connectionStatus.success;
    var bodyHtml = '';
    if (!hasConnection && !store.connectionStatus) {
      bodyHtml += '<div style="padding:10px 14px;border-radius:8px;background:var(--accent-pale);margin-bottom:12px;font-size:12px;color:var(--text-light);line-height:1.5;">💡 先配置 API 并 <b>测试连接</b>，然后从你的提供商加载可用模型。';
    }
    var currentModel = (AppCore.getActiveApiConfig()).model || 'deepseek-chat';
    var providerKeys = Object.keys(groups);
    for (var pk = 0; pk < providerKeys.length; pk++) {
      var provider = providerKeys[pk];
      var groupModels = groups[provider];
      bodyHtml += '<div style="font-family:var(--font-en);font-size:10px;color:var(--text-lighter);letter-spacing:0.06em;margin:10px 0 4px;">' + (PROVIDER_NAMES[provider] || provider.toUpperCase()) + '</div>';
      for (var gi = 0; gi < groupModels.length; gi++) {
        var m = groupModels[gi];
        var fmtLabel = m.format ? ' · ' + (FORMAT_NAMES[m.format] || m.format) : '';
        bodyHtml += '<div class="model-select-item' + (m.id === currentModel ? ' active' : '') + '" onclick="setActiveModel(\'' + m.id + '\');UIModule.closeModal();" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:2px;' + (m.id === currentModel ? 'background:var(--accent-pale);' : '') + '"><span style="font-size:13px;">' + m.label + '</span><span style="font-size:10px;color:var(--text-lighter);">' + m.id + fmtLabel + '</span></div>';
      }
    }
    bodyHtml += '<button class="test-conn-btn" onclick="fetchModelsFromAPI()" style="margin-top:8px;width:100%;">刷新模型列表</button>';
    UIModule.showModal('选择模型', bodyHtml, [{ label: 'close', cls: 'cancel', onclick: UIModule.closeModal }]);
  }

  function updateSettingsUI() {
    var store = AppCore.getStore();
    var proj = AppCore.getActiveProject();
    var ais = AppCore.getActiveChatAiSettings();
    var ac = AppCore.getActiveApiConfig();
    var toggle = function(id, on) { var el = AppCore.$('toggle' + id); if (el) { if (on) el.classList.add('on'); else el.classList.remove('on'); } };
    toggle('DateTime', ais.autoDateTime);
    toggle('Weather', ais.autoWeather);
    toggle('Voice', ais.aiVoice);
    toggle('Search', ais.webSearch);
    var mv = AppCore.$('modelVal');
    if (mv) mv.textContent = ac.model || 'deepseek-chat';
    var av = AppCore.$('aiNameVal');
    if (av) av.textContent = (proj && proj.aiName) ? proj.aiName : (store.aiName || 'warmbuddy');
    var pv = AppCore.$('prefVal');
    if (pv) pv.textContent = (proj && proj.preference) ? proj.preference.slice(0, 20) + (proj.preference.length > 20 ? '…' : '') : 'edit';
    var aks = AppCore.$('apiKeyStatus');
    if (aks) aks.textContent = ac.apiKey ? '●●●●●●●●' + ac.apiKey.slice(-4) : '●●●●●●●●';
    var aev = AppCore.$('apiEndpointVal');
    if (aev) aev.textContent = ac.model || 'not set';
    // Toolkit list
    var tkm = AppCore.getModule('toolkit');
    if (tkm && tkm.renderToolkitList) tkm.renderToolkitList();
    // Theme picker
    var uiMod = AppCore.getModule('ui');
    if (uiMod && uiMod.renderThemePicker) uiMod.renderThemePicker();
    // Email settings
    if (typeof updateEmailSettingsUI === 'function') updateEmailSettingsUI();
  }

  function toggleAiSetting(k) {
    var store = AppCore.getStore();
    var chat = AppCore.getActiveChatObj();
    var ais = chat && chat.aiSettings ? chat.aiSettings : store.aiSettings;
    if (!ais) return;
    ais[k] = !ais[k];
    AppCore.saveStore();
    updateSettingsUI();
    UIModule.toast(k + ': ' + (ais[k] ? 'ON' : 'OFF'));
  }

  function init() {
    console.log('[SettingsModule] ✅ initialized');
  }

  return {
    init: init,
    PROVIDER_NAMES: PROVIDER_NAMES,
    FORMAT_NAMES: FORMAT_NAMES,
    loadPresets: loadPresets,
    selectPreset: selectPreset,
    showApiModal: showApiModal,
    saveApiConfig: saveApiConfig,
    showProjectApiModal: showProjectApiModal,
    saveProjectApiConfig: saveProjectApiConfig,
    testProjectConnection: testProjectConnection,
    testConnection: testConnection,
    fetchModelsFromAPI: fetchModelsFromAPI,
    showModelModal: showModelModal,
    updateSettingsUI: updateSettingsUI,
    toggleAiSetting: toggleAiSetting
  };
})();

AppCore.register('settings', SettingsModule);
