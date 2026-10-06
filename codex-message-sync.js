'use strict';

const CODEX_PROJECT_ID = 'codex-code-test';
const CODEX_RUNTIME = 'codex-gateway';
const CODEX_SYNC_ERROR = 'CODEX_SYNC_INVALID_REQUEST';
const CODEX_SYNC_STATUSES = new Set(['running', 'completed', 'failed', 'canceled', 'unknown']);
const CODEX_ROLES = new Set(['user', 'assistant']);
const CODEX_MAX_PAGE_SIZE = 100;
const CODEX_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const CODEX_METADATA_KEYS = new Set(['runtime', 'turnId', 'turnStatus', 'messageIndex', 'updatedAt', 'contentType']);
const CODEX_TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'unknown']);

function invalid(message = CODEX_SYNC_ERROR) {
  const error = new Error(message);
  error.code = CODEX_SYNC_ERROR;
  error.status = 400;
  return error;
}

function text(value, field, { required = true, maxBytes = 256 } = {}) {
  if (value === undefined || value === null) {
    if (!required) return '';
    throw invalid();
  }
  if (typeof value !== 'string' || (required && !value.trim())) throw invalid();
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw invalid();
  return value;
}

function normalizeCodexMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid();
  const result = {};
  for (const key of CODEX_METADATA_KEYS) {
    if (metadata[key] === undefined) continue;
    if (key === 'messageIndex') {
      if (!Number.isInteger(metadata[key]) || metadata[key] < 0 || metadata[key] > 4095) throw invalid();
      result[key] = metadata[key];
      continue;
    }
    if (key === 'turnStatus') {
      if (!CODEX_SYNC_STATUSES.has(metadata[key])) throw invalid();
      result[key] = metadata[key];
      continue;
    }
    if (key === 'runtime') {
      if (metadata[key] !== CODEX_RUNTIME) throw invalid();
      result[key] = CODEX_RUNTIME;
      continue;
    }
    result[key] = text(metadata[key], key, { maxBytes: key === 'contentType' ? 128 : 256 });
  }
  if (result.runtime !== CODEX_RUNTIME || !result.turnId || !result.turnStatus || !result.updatedAt) throw invalid();
  if (Number.isNaN(Date.parse(result.updatedAt))) throw invalid();
  return result;
}

function normalizeCodexMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.project_id !== CODEX_PROJECT_ID) return null;
  if (!CODEX_ROLES.has(message.role)) return null;
  let metadata;
  try {
    metadata = normalizeCodexMetadata(message.metadata);
  } catch {
    return null;
  }
  const projectId = text(message.project_id, 'project_id');
  const windowId = text(message.window_id, 'window_id');
  const messageId = text(message.message_id, 'message_id');
  const content = text(message.content, 'content', { required: false, maxBytes: CODEX_MAX_CONTENT_BYTES });
  const createdAt = text(message.created_at, 'created_at', { maxBytes: 64 });
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return {
    project_id: projectId,
    window_id: windowId,
    message_id: messageId,
    role: message.role,
    content,
    token_usage: Number.isFinite(message.token_usage) ? Math.max(0, message.token_usage) : 0,
    created_at: createdAt,
    metadata
  };
}

function statusOf(row) {
  return row && row.metadata && row.metadata.turnStatus;
}

function isTerminal(status) {
  return CODEX_TERMINAL_STATUSES.has(status);
}

function shouldApplyCodexUpdate(existing, incoming) {
  const oldStatus = statusOf(existing);
  const nextStatus = statusOf(incoming);
  if (!oldStatus) return true;
  if (isTerminal(oldStatus) && !isTerminal(nextStatus)) return false;
  if (!isTerminal(oldStatus) && isTerminal(nextStatus)) return true;
  const oldTime = Date.parse(existing.metadata.updatedAt) || 0;
  const nextTime = Date.parse(incoming.metadata.updatedAt) || 0;
  return nextTime >= oldTime;
}

function buildCodexConversationQuery({ projectId, windowId = '', cursor = '', limit = 100 } = {}) {
  if (projectId !== CODEX_PROJECT_ID) throw invalid();
  if (windowId !== '' && (typeof windowId !== 'string' || !windowId.trim() || Buffer.byteLength(windowId, 'utf8') > 256)) throw invalid();
  if (cursor !== '' && (!/^\d+$/.test(String(cursor)) || Number(cursor) < 0)) throw invalid();
  const numericLimit = Number(limit);
  if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > CODEX_MAX_PAGE_SIZE) throw invalid();
  return {
    projectId: CODEX_PROJECT_ID,
    windowId,
    cursor: cursor === '' ? '' : String(Number(cursor)),
    limit: numericLimit
  };
}

module.exports = {
  CODEX_MAX_PAGE_SIZE,
  CODEX_PROJECT_ID,
  CODEX_RUNTIME,
  CODEX_SYNC_ERROR,
  buildCodexConversationQuery,
  normalizeCodexMessage,
  normalizeCodexMetadata,
  shouldApplyCodexUpdate
};
