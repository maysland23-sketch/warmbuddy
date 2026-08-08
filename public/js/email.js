/**
 * WarmBuddy Email Module
 * ── Email configuration and sending via Resend ──
 */

var EmailModule = (function() {
  'use strict';

  // ═══════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════

  function extractEmailFromResponse(text) {
    if (!text) return null;
    var re = /\[\[EMAIL:([^\]|]+)(?:\|([\s\S]*?))?\]\]/;
    var m = text.match(re);
    if (!m) return null;
    return { subject: m[1].trim(), body: (m[2] || '').trim() };
  }

  // ═══════════════════════════════════════════
  //  Show config modal
  // ═══════════════════════════════════════════

  function showConfig() {
    UIModule.showModal('邮件配置',
      '<div style="font-size:11px;color:var(--text-lighter);margin-bottom:4px;">固定收件人</div>' +
      '<input class="modal-input" id="emailRecipientInput" placeholder="收件人邮箱">' +
      '<div style="font-size:11px;color:var(--text-lighter);margin:12px 0 4px;">发件人名称</div>' +
      '<input class="modal-input" id="emailSenderNameInput" placeholder="WarmBuddy">' +
      '<div style="font-size:10px;color:var(--text-lighter);margin:2px 0 12px;">发件地址为 onboarding@resend.dev（Resend 免费层）</div>',
      [
        { label: 'cancel', cls: 'cancel', onclick: UIModule.closeModal },
        { label: 'save', cls: 'confirm', onclick: EmailModule.saveConfig }
      ]
    );
    fetch(AppCore.BACKEND_URL + '/api/email/status').then(function(r) { return r.json(); }).then(function(s) {
      var recEl = AppCore.$('emailRecipientInput'), nameEl = AppCore.$('emailSenderNameInput');
      if (recEl && s.recipient) recEl.value = s.recipient;
      if (nameEl && s.senderName) nameEl.value = s.senderName;
    }).catch(function() {});
  }

  // ═══════════════════════════════════════════
  //  Save config
  // ═══════════════════════════════════════════

  function saveConfig() {
    var store = AppCore.getStore();
    var recipient = AppCore.$('emailRecipientInput').value.trim();
    var senderName = AppCore.$('emailSenderNameInput').value.trim();
    fetch(AppCore.BACKEND_URL + '/api/email/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: recipient, senderName: senderName })
    }).then(function(r) { return r.json(); }).then(function(d) {
      store._importing = true;
      UIModule.closeModal();
      if (d.configured) UIModule.toast('✅ 邮件已配置'); else UIModule.toast('⚠️ 请填写收件人邮箱');
      EmailModule.updateUI();
    }).catch(function() { UIModule.toast('配置保存失败'); });
  }

  // ═══════════════════════════════════════════
  //  Toggle enabled
  // ═══════════════════════════════════════════

  function toggleEnabled() {
    var chat = AppCore.getActiveChatObj();
    if (!chat) return;
    chat.emailEnabled = !chat.emailEnabled;
    EmailModule.updateUI();
    AppCore.saveStore();
    UIModule.toast('邮件发送: ' + (chat.emailEnabled ? 'ON' : 'OFF'));
  }

  // ═══════════════════════════════════════════
  //  Update settings UI
  // ═══════════════════════════════════════════

  function updateUI() {
    var chat = AppCore.getActiveChatObj();
    AppCore.$('toggleEmail').classList.toggle('on', !!(chat && chat.emailEnabled));
    fetch(AppCore.BACKEND_URL + '/api/email/status').then(function(r) { return r.json(); }).then(function(s) {
      var status = s.apiKeySet ? (s.recipient ? '已配置' : '缺收件人') : 'API Key 未设';
      AppCore.$('emailStatusVal').textContent = status;
      AppCore.$('emailSentVal').textContent = s.sentToday + '/' + s.maxPerDay;
    }).catch(function() {});
  }

  // ═══════════════════════════════════════════
  //  Send email
  // ═══════════════════════════════════════════

  async function send(chat, subject, body) {
    var typingArea = AppCore.$('chatTypingArea');
    if (typingArea) typingArea.innerHTML = '<div class="typing-indicator">正在写邮件……<span class="streaming-cursor">|</span></div>';
    var cfg = AppCore.getActiveApiConfig();
    if (!cfg || !cfg.apiKey) { UIModule.toast('请先配置API Key'); return false; }
    try {
      var msgs = [];
      for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (m.role === 'system') continue;
        msgs.push({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.text });
      }
      var resp = await fetch(AppCore.BACKEND_URL + '/api/email/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject, messages: msgs, apiConfig: { apiKey: cfg.apiKey, endpoint: cfg.endpoint, model: cfg.model } })
      });
      var data = await resp.json();
      if (data.ok) {
        chat.messages.push({ role: 'system', contentType: 'email_notification', text: '邮件已发送', time: AppCore.nowTime() });
        if (typingArea) typingArea.innerHTML = '';
        return true;
      } else {
        UIModule.toast('邮件发送失败: ' + (data.error || '未知错误'));
        if (typingArea) typingArea.innerHTML = '';
        return false;
      }
    } catch (e) {
      console.error('[email]', e.message);
      UIModule.toast('邮件发送失败: ' + e.message);
      if (typingArea) typingArea.innerHTML = '';
      return false;
    }
  }

  // ═══════════════════════════════════════════
  //  Init
  // ═══════════════════════════════════════════

  function init() {
    console.log('[EmailModule] ✅ initialized');
  }

  // ═══════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════

  return {
    init: init,
    showConfig: showConfig,
    saveConfig: saveConfig,
    toggleEnabled: toggleEnabled,
    updateUI: updateUI,
    extractFromResponse: extractEmailFromResponse,
    send: send
  };
})();

AppCore.register('email', EmailModule);
