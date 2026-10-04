'use strict';

const { createProactiveChatMessage } = require('./proactive-message-utils');

function isAiStatusEventType(type) {
  return type === 'status' || type === 'ai_status_change';
}

function normalizeAiStatus(value) {
  return String(value || '').trim().substring(0, 15);
}

function getStatusEventContent({ status, message } = {}) {
  return normalizeAiStatus(status) || String(message || '').trim();
}

function createStatusNotice({
  projectId,
  windowId,
  messageId,
  eventId,
  driveKey,
  createdAt,
  actionType = 'status',
  aiName
}) {
  return createProactiveChatMessage({
    projectId,
    windowId,
    messageId,
    role: 'system',
    content: '戳一戳更新了',
    createdAt,
    actionType,
    driveKey,
    eventId,
    metadata: { content_type: 'status_notification' }
  });
}

module.exports = {
  isAiStatusEventType,
  normalizeAiStatus,
  getStatusEventContent,
  createStatusNotice
};
