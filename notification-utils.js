'use strict';

const DRIVE_LABELS = {
  resonance: '共鸣欲',
  exploration: '探索欲',
  possession: '占有欲',
  guardianship: '守护欲',
  intimacy: '亲近欲',
  confirmation: '确认欲',
  devotion: '献祭欲'
};

function buildNotificationPayload(input) {
  const aiName = String(input.aiName || '暖伴').trim() || '暖伴';
  const actionType = input.actionType || 'message';
  const content = String(input.content || '').trim();
  let title;
  let body;
  let priority = 3;

  switch (actionType) {
    case 'message':
      title = aiName + ' · ' + (DRIVE_LABELS[input.driveKey] || input.driveKey || '消息');
      body = content;
      priority = 4;
      break;
    case 'todo':
      title = aiName + ' · 新待办';
      body = content;
      priority = 4;
      break;
    case 'todo_wake':
      title = aiName + ' · 待办提醒';
      body = content;
      priority = 5;
      break;
    case 'diary':
      title = aiName + ' · 日记';
      body = aiName + '刚刚写了篇日记';
      break;
    case 'litter':
      title = aiName + ' · 🐾 猫砂盆';
      body = '猫砂盆好像需要铲一铲';
      break;
    case 'email':
      title = aiName + ' · 邮件';
      body = aiName + '刚刚给你发送了邮件';
      break;
    case 'poke':
      title = aiName + ' · 戳一戳';
      body = aiName + '刚刚戳了戳你';
      break;
    case 'status':
      title = aiName + ' · 状态更新';
      body = aiName + '有了新的状态';
      break;
    default:
      title = aiName + ' · 消息';
      body = content;
  }

  return { title, body, priority };
}

async function sendNtfyNotification(options) {
  const baseUrl = String(options.baseUrl || '').trim().replace(/\/+$/, '');
  const topic = String(options.topic || '').trim();
  if (!baseUrl) throw new Error('ntfy base URL is required');
  if (!topic) throw new Error('ntfy topic is required');

  const headers = {
    'Content-Type': 'application/json'
  };
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.eventId !== undefined && options.eventId !== null) {
    headers['X-Sequence-ID'] = String(options.eventId);
  }

  const message = {
    topic,
    title: String(options.title || '暖伴'),
    message: String(options.body || ''),
    priority: options.priority || 3
  };
  if (options.clickUrl) message.click = options.clickUrl;

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(baseUrl + '/', {
    method: 'POST',
    headers,
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    let detail = '';
    if (response.text) detail = (await response.text()).trim();
    throw new Error('ntfy publish failed: ' + response.status + (detail ? ' ' + detail : ''));
  }

  if (response.json) return response.json();
  return null;
}

function createNotificationDispatcher(options) {
  const config = options || {};
  const publish = config.publish || sendNtfyNotification;
  const maxAttempts = Math.max(1, Number(config.maxAttempts) || 1);
  const retryDelayMs = Math.max(0, Number(config.retryDelayMs) || 0);

  return async function dispatch(input) {
    if (!config.topic) {
      return { sent: false, skipped: true, reason: 'not_configured' };
    }

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (config.markAttempt) {
        try {
          await config.markAttempt(input.eventId, attempt);
        } catch (error) {
          if (config.onStatusError) config.onStatusError(error);
        }
      }
      try {
        const result = await publish({
          baseUrl: config.baseUrl,
          topic: config.topic,
          token: config.token,
          eventId: input.eventId,
          title: input.title,
          body: input.body,
          priority: input.priority,
          clickUrl: input.clickUrl
        });
        if (config.markSent) {
          try {
            await config.markSent(input.eventId, result);
          } catch (error) {
            if (config.onStatusError) config.onStatusError(error);
          }
        }
        return { sent: true, result };
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    if (config.markFailed) {
      try {
        await config.markFailed(input.eventId, lastError);
      } catch (error) {
        if (config.onStatusError) config.onStatusError(error);
      }
    }
    return { sent: false, error: lastError };
  };
}

module.exports = {
  buildNotificationPayload,
  sendNtfyNotification,
  createNotificationDispatcher
};
