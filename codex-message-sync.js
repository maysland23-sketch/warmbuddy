'use strict';

const receiptContract = require('./public/js/codex-receipt-contract');

const CODEX_PROJECT_ID = 'codex-code-test';
const CODEX_RUNTIME = 'codex-gateway';
const CODEX_SYNC_ERROR = 'CODEX_SYNC_INVALID_REQUEST';
const CODEX_SYNC_STATUSES = new Set(['running', 'completed', 'failed', 'canceled', 'unknown']);
const CODEX_ROLES = new Set(['user', 'assistant']);
const CODEX_MAX_PAGE_SIZE = 100;
const CODEX_MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const CODEX_METADATA_KEYS = new Set(['runtime', 'turnId', 'turnStatus', 'messageIndex', 'updatedAt', 'contentType', 'version', 'writerId', 'receipts', 'receiptProfile']);
const CODEX_TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'unknown']);
const CODEX_RECEIPT_PROFILE = receiptContract.PROFILE;
const CODEX_RECEIPT_PROFILE_REQUIRED = 'CODEX_RECEIPT_PROFILE_REQUIRED';
const CODEX_RECEIPT_PROFILE_UNSUPPORTED = 'CODEX_RECEIPT_PROFILE_UNSUPPORTED';
const CODEX_RECEIPT_UPDATE_CONFLICT = 'CODEX_RECEIPT_UPDATE_CONFLICT';
const CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT = 'CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT';

function invalid(message = CODEX_SYNC_ERROR) {
  const error = new Error(message);
  error.code = CODEX_SYNC_ERROR;
  error.status = 400;
  return error;
}

function protectionError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function validateCodexReceiptProfile(value, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw protectionError(CODEX_RECEIPT_PROFILE_REQUIRED, 428);
    return undefined;
  }
  if (value !== CODEX_RECEIPT_PROFILE) throw protectionError(CODEX_RECEIPT_PROFILE_UNSUPPORTED, 400);
  return CODEX_RECEIPT_PROFILE;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isCodexProtectedMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  if (hasOwn(metadata, 'receiptProfile')) return true;
  return !!(metadata.receipts && Array.isArray(metadata.receipts.activities) &&
    metadata.receipts.activities.some(activity => activity && activity.tool === 'github_mcp'));
}

function isCodexProtectedRow(row) {
  return !!row && isCodexProtectedMetadata(row.metadata);
}

function assertCodexMessageOwnership(existing, incoming) {
  if (!existing || existing.project_id !== incoming.project_id || existing.window_id !== incoming.window_id ||
      !existing.metadata || existing.metadata.runtime !== CODEX_RUNTIME) {
    throw protectionError(CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT, 409);
  }
}

function protectedUpdateConflict() {
  throw protectionError(CODEX_RECEIPT_UPDATE_CONFLICT, 409);
}

function equalCanonicalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertOptionalContextCompatible(existing, incoming) {
  if (!hasOwn(existing, 'context') || !hasOwn(incoming, 'context')) return;
  const fields = ['owner', 'repo', 'path', 'ref', 'commit'];
  for (const field of fields) {
    if (hasOwn(existing.context, field) && hasOwn(incoming.context, field) &&
        existing.context[field] !== incoming.context[field]) protectedUpdateConflict();
  }
}

function assertOptionalDisplayCompatible(existing, incoming, fields) {
  assertOptionalContextCompatible(existing, incoming);
  for (const field of fields) {
    if (field === 'context') continue;
    if (hasOwn(existing, field) && hasOwn(incoming, field) &&
        !equalCanonicalValue(existing[field], incoming[field])) protectedUpdateConflict();
  }
}

function assertSourceCardCompatible(existing, incoming) {
  const coreFields = ['requestId', 'activityId', 'sourceId', 'displayUrl', 'redacted', 'url', 'linkKind'];
  for (const field of coreFields) {
    if (hasOwn(existing, field) !== hasOwn(incoming, field) ||
        (hasOwn(existing, field) && !equalCanonicalValue(existing[field], incoming[field]))) {
      protectedUpdateConflict();
    }
  }
  assertOptionalDisplayCompatible(existing, incoming, ['title', 'refId', 'context']);
}

function activityKey(activity) {
  return activity.requestId + '\u0000' + activity.activityId;
}

function indexActivities(receipts) {
  const result = new Map();
  for (const activity of receipts.activities) result.set(activityKey(activity), activity);
  return result;
}

function sourceStateRank(value) {
  return value === 'none' ? 1 : value === 'available' ? 2 : 0;
}

function assertProtectedActivityCompatible(existing, incoming) {
  for (const field of ['requestId', 'activityId', 'tool']) {
    if (existing[field] !== incoming[field]) protectedUpdateConflict();
  }
  const canBindWebActionAtSettlement = existing.tool === 'web_search' &&
    existing.phase === 'started' && existing.action === 'unknown' &&
    (incoming.phase === 'completed' || incoming.phase === 'interrupted') &&
    (incoming.action === 'search' || incoming.action === 'open_page');
  if (existing.action !== incoming.action && !canBindWebActionAtSettlement) {
    protectedUpdateConflict();
  }

  if (existing.phase === 'started') {
    if (!['started', 'completed', 'interrupted'].includes(incoming.phase)) protectedUpdateConflict();
    if (incoming.phase === 'started' && existing.outcome !== incoming.outcome) protectedUpdateConflict();
  } else {
    if (incoming.phase !== existing.phase || incoming.outcome !== existing.outcome) protectedUpdateConflict();
    if (existing.phase === 'interrupted' && existing.reason !== incoming.reason) protectedUpdateConflict();
    if (existing.outcome === 'failed' && hasOwn(existing, 'reason') &&
        (!hasOwn(incoming, 'reason') || incoming.reason !== existing.reason)) protectedUpdateConflict();
  }

  if (existing.phase === 'completed' && incoming.phase === 'completed' &&
      sourceStateRank(incoming.sources) < sourceStateRank(existing.sources)) protectedUpdateConflict();

  assertOptionalDisplayCompatible(existing, incoming, [
    'context', 'targetSourceId', 'targetDisplayUrl', 'targetRedacted', 'targetUrl'
  ]);
}

function omissionCount(receipts) {
  return Number.isSafeInteger(receipts.omittedSources) && receipts.omittedSources >= 0
    ? receipts.omittedSources : 0;
}

function assertProtectedSourcesCompatible(existingReceipts, incomingReceipts, existingActivities, incomingActivities) {
  const existingOmitted = omissionCount(existingReceipts);
  const incomingOmitted = omissionCount(incomingReceipts);
  if (incomingOmitted < existingOmitted) protectedUpdateConflict();

  let missingVisibleSources = 0;
  let sourcePrefixEnded = false;
  for (const existingActivity of existingReceipts.activities) {
    const incomingActivity = incomingActivities.get(activityKey(existingActivity));
    if (!incomingActivity) protectedUpdateConflict();
    const existingCards = existingActivity.sourceCards;
    const incomingCards = incomingActivity.sourceCards;
    if (sourcePrefixEnded && incomingCards.length > 0) protectedUpdateConflict();
    const commonCount = Math.min(existingCards.length, incomingCards.length);
    for (let index = 0; index < commonCount; index++) {
      assertSourceCardCompatible(existingCards[index], incomingCards[index]);
    }
    if (incomingCards.length < existingCards.length) {
      missingVisibleSources += existingCards.length - incomingCards.length;
      sourcePrefixEnded = true;
    }
  }

  if (sourcePrefixEnded) {
    for (const [key, incomingActivity] of incomingActivities) {
      if (!existingActivities.has(key) && incomingActivity.sourceCards.length > 0) {
        protectedUpdateConflict();
      }
    }
  }

  if (missingVisibleSources > 0 &&
      (incomingReceipts.omitted !== true || incomingOmitted < existingOmitted + missingVisibleSources)) {
    protectedUpdateConflict();
  }
}

function assertCodexProtectedUpdate(existing, incoming, requestProfile) {
  if (!isCodexProtectedRow(existing)) return;
  if (requestProfile !== CODEX_RECEIPT_PROFILE) throw protectionError(CODEX_RECEIPT_PROFILE_REQUIRED, 428);
  const existingMetadata = existing.metadata;
  const incomingMetadata = incoming.metadata;
  const existingReceipts = existingMetadata && existingMetadata.receipts;
  const incomingReceipts = incomingMetadata && incomingMetadata.receipts;
  if (incomingMetadata.receiptProfile !== CODEX_RECEIPT_PROFILE || !incomingReceipts ||
      !Array.isArray(incomingReceipts.activities) ||
      !existingReceipts || !Array.isArray(existingReceipts.activities) ||
      incomingReceipts.activities.length < existingReceipts.activities.length) {
    throw protectionError(CODEX_RECEIPT_UPDATE_CONFLICT, 409);
  }

  const existingActivities = indexActivities(existingReceipts);
  const incomingActivities = indexActivities(incomingReceipts);
  for (const [key, existingActivity] of existingActivities) {
    const incomingActivity = incomingActivities.get(key);
    if (!incomingActivity) protectedUpdateConflict();
    assertProtectedActivityCompatible(existingActivity, incomingActivity);
  }
  assertProtectedSourcesCompatible(existingReceipts, incomingReceipts, existingActivities, incomingActivities);
}

function codexMessagesEqual(existing, incoming) {
  const normalizedExisting = normalizeCodexMessage(existing);
  if (!normalizedExisting) return false;
  return JSON.stringify(normalizedExisting) === JSON.stringify(incoming);
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

function normalizeCodexReceipts(receipts, options) {
  try {
    return receiptContract.normalizeReceiptSet(receipts, options);
  } catch {
    throw invalid();
  }
}

function compactCodexReceipts(receipts, options) {
  try {
    return receiptContract.compactReceiptSet(receipts, options);
  } catch {
    throw invalid();
  }
}

function normalizeCodexMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid();
  const hasReceiptProfile = Object.prototype.hasOwnProperty.call(metadata, 'receiptProfile');
  const hasReceipts = Object.prototype.hasOwnProperty.call(metadata, 'receipts') && metadata.receipts !== undefined;
  if (hasReceiptProfile && metadata.receiptProfile !== CODEX_RECEIPT_PROFILE) throw invalid();
  if (hasReceiptProfile && !hasReceipts) throw invalid();
  const receiptOptions = hasReceiptProfile ? { profile: CODEX_RECEIPT_PROFILE } : undefined;
  const result = {};
  for (const key of CODEX_METADATA_KEYS) {
    if (key === 'receiptProfile') {
      if (hasReceiptProfile) result.receiptProfile = CODEX_RECEIPT_PROFILE;
      continue;
    }
    if (key === 'receipts') {
      if (hasReceipts) result.receipts = normalizeCodexReceipts(metadata.receipts, receiptOptions);
      continue;
    }
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
  CODEX_RECEIPT_PROFILE,
  CODEX_RECEIPT_PROFILE_REQUIRED,
  CODEX_RECEIPT_PROFILE_UNSUPPORTED,
  CODEX_RECEIPT_UPDATE_CONFLICT,
  CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT,
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
  shouldApplyCodexUpdate,
  validateCodexReceiptProfile,
  isCodexProtectedMetadata,
  isCodexProtectedRow,
  assertCodexMessageOwnership,
  assertCodexProtectedUpdate,
  codexMessagesEqual
};
