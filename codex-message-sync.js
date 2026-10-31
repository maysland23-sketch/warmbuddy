'use strict';

const { isIP } = require('node:net');

const CODEX_PROJECT_ID = 'codex-code-test';
const CODEX_RUNTIME = 'codex-gateway';
const CODEX_SYNC_ERROR = 'CODEX_SYNC_INVALID_REQUEST';
const CODEX_SYNC_STATUSES = new Set(['running', 'completed', 'failed', 'canceled', 'unknown']);
const CODEX_ROLES = new Set(['user', 'assistant']);
const CODEX_MAX_PAGE_SIZE = 100;
const CODEX_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const CODEX_METADATA_KEYS = new Set(['runtime', 'turnId', 'turnStatus', 'messageIndex', 'updatedAt', 'contentType', 'version', 'writerId', 'receipts']);
const CODEX_TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'unknown']);
const CODEX_RECEIPT_REQUEST_ID = /^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX_RECEIPT_ACTIVITY_ID = /^wa_[1-9][0-9]*$/;
const CODEX_RECEIPT_SOURCE_ID = /^ws_[0-9a-f]{64}$/;
const CODEX_RECEIPT_REF_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const CODEX_RECEIPT_MAX_ACTIVITIES = 64;
const CODEX_RECEIPT_MAX_SOURCES = 8;
const CODEX_RECEIPT_MAX_URL_BYTES = 2048;
const CODEX_RECEIPT_MAX_TITLE_BYTES = 256;
const CODEX_RECEIPT_MAX_BYTES = 64 * 1024;

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

function receiptText(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function receiptPublicUrl(value) {
  if (!receiptText(value, CODEX_RECEIPT_MAX_URL_BYTES) || /[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (!/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || '').toLowerCase();
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash &&
      isIP(host) === 0 && host.includes('.') && !host.endsWith('.') &&
      !/(^|\.)(localhost|local|internal|invalid|test)$/.test(host) && /^[a-z0-9.-]+$/.test(host);
  } catch {
    return false;
  }
}

function normalizeCodexReceiptSource(source, requestId, activityId, sourceIds) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      source.requestId !== requestId || source.activityId !== activityId ||
      !CODEX_RECEIPT_SOURCE_ID.test(source.sourceId || '') || sourceIds.has(source.sourceId) ||
      !receiptPublicUrl(source.displayUrl) || typeof source.redacted !== 'boolean') throw invalid();
  if (source.redacted) {
    if (Object.prototype.hasOwnProperty.call(source, 'url')) throw invalid();
  } else if (!receiptPublicUrl(source.url) || source.url !== source.displayUrl) {
    throw invalid();
  }
  const result = {
    requestId, activityId, sourceId: source.sourceId,
    displayUrl: source.displayUrl, redacted: source.redacted
  };
  if (!source.redacted) result.url = source.url;
  if (source.title !== undefined) {
    if (!receiptText(source.title, CODEX_RECEIPT_MAX_TITLE_BYTES)) throw invalid();
    if (source.title) result.title = source.title;
  }
  if (source.refId !== undefined) {
    if (typeof source.refId !== 'string' || !CODEX_RECEIPT_REF_ID.test(source.refId)) throw invalid();
    result.refId = source.refId;
  }
  sourceIds.add(source.sourceId);
  return result;
}

function compactCodexReceipts(receipts) {
  const priorOmittedSources = Number.isInteger(receipts.omittedSources) ? receipts.omittedSources : 0;
  const totalSources = priorOmittedSources + receipts.activities.reduce((total, activity) => (
    total + (Array.isArray(activity.sourceCards) ? activity.sourceCards.length : 0)
  ), 0);
  const result = {
    activities: receipts.activities.map(activity => {
      const compacted = {
        requestId: activity.requestId, activityId: activity.activityId,
        tool: 'web_search', phase: activity.phase,
        action: activity.action, outcome: 'unknown', sourceCards: []
      };
      if (activity.phase === 'completed') compacted.sources = activity.sources;
      if (activity.phase === 'interrupted') compacted.reason = activity.reason;
      return compacted;
    }),
    omitted: true,
    omittedSources: totalSources
  };
  let retainedSources = 0;
  for (let activityIndex = 0; activityIndex < receipts.activities.length; activityIndex++) {
    const sourceCards = Array.isArray(receipts.activities[activityIndex].sourceCards)
      ? receipts.activities[activityIndex].sourceCards : [];
    for (const source of sourceCards) {
      result.activities[activityIndex].sourceCards.push(source);
      result.omittedSources = totalSources - (++retainedSources);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CODEX_RECEIPT_MAX_BYTES) {
        result.activities[activityIndex].sourceCards.pop();
        retainedSources--;
        result.omittedSources = totalSources - retainedSources;
      }
    }
  }
  return result;
}

function normalizeCodexReceipts(receipts) {
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts) || !Array.isArray(receipts.activities) ||
      receipts.activities.length > CODEX_RECEIPT_MAX_ACTIVITIES) throw invalid();
  if (receipts.omitted !== undefined && typeof receipts.omitted !== 'boolean') throw invalid();
  if (receipts.omittedSources !== undefined &&
      (!Number.isInteger(receipts.omittedSources) || receipts.omittedSources < 0)) throw invalid();
  if (receipts.omittedSources > 0 && receipts.omitted !== true) throw invalid();
  const result = { activities: [] };
  const activityIds = new Set();
  let requestId = null;
  for (const activity of receipts.activities) {
    if (!activity || typeof activity !== 'object' || Array.isArray(activity) ||
        !CODEX_RECEIPT_REQUEST_ID.test(activity.requestId || '') ||
        !CODEX_RECEIPT_ACTIVITY_ID.test(activity.activityId || '') || activityIds.has(activity.activityId) ||
        activity.tool !== 'web_search' || !['started', 'completed', 'interrupted'].includes(activity.phase) ||
        !['unknown', 'search', 'open_page'].includes(activity.action) || activity.outcome !== 'unknown') throw invalid();
    if (requestId && requestId !== activity.requestId) throw invalid();
    requestId = activity.requestId;
    activityIds.add(activity.activityId);
    const hasTarget = ['targetSourceId', 'targetDisplayUrl', 'targetRedacted', 'targetUrl']
      .some(key => Object.prototype.hasOwnProperty.call(activity, key));
    if (hasTarget && activity.action !== 'open_page') throw invalid();
    const normalized = {
      requestId, activityId: activity.activityId, tool: 'web_search', phase: activity.phase,
      action: activity.action, outcome: 'unknown'
    };
    if (hasTarget) {
      if (!CODEX_RECEIPT_SOURCE_ID.test(activity.targetSourceId || '') ||
          !receiptPublicUrl(activity.targetDisplayUrl) || typeof activity.targetRedacted !== 'boolean') throw invalid();
      if (activity.targetRedacted) {
        if (Object.prototype.hasOwnProperty.call(activity, 'targetUrl')) throw invalid();
      } else if (!receiptPublicUrl(activity.targetUrl) || activity.targetUrl !== activity.targetDisplayUrl) {
        throw invalid();
      }
      normalized.targetSourceId = activity.targetSourceId;
      normalized.targetDisplayUrl = activity.targetDisplayUrl;
      normalized.targetRedacted = activity.targetRedacted;
      if (!activity.targetRedacted) normalized.targetUrl = activity.targetUrl;
    }
    if (activity.phase === 'completed') {
      if (!['available', 'none', 'unknown'].includes(activity.sources)) throw invalid();
      normalized.sources = activity.sources;
    }
    if (activity.phase === 'interrupted') {
      if (!['turn_ended', 'round_failed', 'cancelled'].includes(activity.reason)) throw invalid();
      normalized.reason = activity.reason;
    }
    if (!Array.isArray(activity.sourceCards) || activity.sourceCards.length > CODEX_RECEIPT_MAX_SOURCES || activity.phase !== 'completed' && activity.sourceCards.length) throw invalid();
    const sourceIds = new Set();
    normalized.sourceCards = activity.sourceCards.map(source => normalizeCodexReceiptSource(source, requestId, activity.activityId, sourceIds));
    result.activities.push(normalized);
  }
  if (receipts.omitted === true) {
    result.omitted = true;
    result.omittedSources = receipts.omittedSources || 0;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CODEX_RECEIPT_MAX_BYTES) {
    return compactCodexReceipts(result);
  }
  return result;
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
    if (key === 'version') {
      if (!Number.isInteger(metadata[key]) || metadata[key] < 0 || metadata[key] > 1000000000) throw invalid();
      result[key] = metadata[key];
      continue;
    }
    if (key === 'runtime') {
      if (metadata[key] !== CODEX_RUNTIME) throw invalid();
      result[key] = CODEX_RUNTIME;
      continue;
    }
    if (key === 'receipts') {
      result.receipts = normalizeCodexReceipts(metadata[key]);
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

function statusRank(status) {
  return status === 'completed' ? 5 : status === 'failed' ? 4 : status === 'canceled' ? 3 : status === 'unknown' ? 2 : 1;
}

function compareCodexUpdates(existing, incoming) {
  if (!existing) return -1;
  const oldStatus = statusOf(existing);
  const nextStatus = statusOf(incoming);
  const oldVersion = Number.isInteger(existing.metadata && existing.metadata.version) ? existing.metadata.version : 0;
  const nextVersion = Number.isInteger(incoming.metadata && incoming.metadata.version) ? incoming.metadata.version : 0;
  if (nextVersion !== oldVersion && (oldVersion > 0 || nextVersion > 0)) {
    return nextVersion > oldVersion ? -1 : 1;
  }
  if (isTerminal(oldStatus) && !isTerminal(nextStatus)) return 1;
  if (!isTerminal(oldStatus) && isTerminal(nextStatus)) return -1;

  const oldTime = Date.parse(existing.metadata && existing.metadata.updatedAt) || 0;
  const nextTime = Date.parse(incoming.metadata && incoming.metadata.updatedAt) || 0;
  if (oldVersion === 0 && nextVersion === 0 && nextTime !== oldTime) return nextTime > oldTime ? -1 : 1;

  const oldRank = statusRank(oldStatus);
  const nextRank = statusRank(nextStatus);
  if (nextRank !== oldRank) return nextRank > oldRank ? -1 : 1;
  const oldKey = JSON.stringify([existing.role || '', existing.content || '', existing.metadata && existing.metadata.writerId || '']);
  const nextKey = JSON.stringify([incoming.role || '', incoming.content || '', incoming.metadata && incoming.metadata.writerId || '']);
  if (nextKey === oldKey) return 0;
  return nextKey > oldKey ? -1 : 1;
}

function shouldApplyCodexUpdate(existing, incoming) {
  return compareCodexUpdates(existing, incoming) < 0;
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
  normalizeCodexReceipts,
  compactCodexReceipts,
  compareCodexUpdates,
  shouldApplyCodexUpdate
};
