/**
 * WarmBuddy Email Module
 * ── Email configuration and sending via Resend ──
 */

var EmailModule = (function() {
  'use strict';

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
    updateUI: updateUI
  };
})();

AppCore.register('email', EmailModule);
