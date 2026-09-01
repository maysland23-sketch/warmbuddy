'use strict';

function createProactiveChatMessage(input) {
  if (!input || !input.projectId || !input.windowId || !input.messageId) {
    throw new Error('projectId, windowId, and messageId are required');
  }

  const metadata = { proactive: true };
  if (input.actionType) metadata.action_type = input.actionType;
  if (input.driveKey) metadata.drive_key = input.driveKey;
  if (input.eventId !== undefined && input.eventId !== null) metadata.event_id = input.eventId;
  Object.assign(metadata, input.metadata || {});

  return {
    project_id: input.projectId,
    window_id: input.windowId,
    message_id: input.messageId,
    role: input.role || 'assistant',
    content: input.content || '',
    token_usage: 0,
    created_at: input.createdAt || new Date().toISOString(),
    metadata
  };
}

function normalizeCloudMessage(row) {
  const role = row.role === 'assistant' ? 'ai' : (row.role || 'system');
  const metadata = row.metadata || {};
  return {
    id: row.message_id,
    role,
    text: row.content || '',
    createdAt: row.created_at,
    _proactive: !!metadata.proactive,
    _synced: true,
    _proactiveMessageId: row.message_id
  };
}

function mergeProactiveMessages(existingMessages, cloudRows) {
  const merged = Array.isArray(existingMessages) ? existingMessages.slice() : [];
  const indexById = new Map();

  merged.forEach((message, index) => {
    if (message && message.id) indexById.set(message.id, index);
  });

  (Array.isArray(cloudRows) ? cloudRows : []).forEach(row => {
    if (!row || !row.message_id) return;
    const normalized = normalizeCloudMessage(row);
    const existingIndex = indexById.get(row.message_id);
    if (existingIndex === undefined) {
      indexById.set(row.message_id, merged.length);
      merged.push(normalized);
    } else {
      merged[existingIndex] = Object.assign({}, merged[existingIndex], normalized);
    }
  });

  return merged.sort((a, b) => {
    const aTime = a && (a.createdAt || a.created_at);
    const bTime = b && (b.createdAt || b.created_at);
    if (!aTime || !bTime) return 0;
    return String(aTime).localeCompare(String(bTime));
  });
}

module.exports = { createProactiveChatMessage, mergeProactiveMessages };
