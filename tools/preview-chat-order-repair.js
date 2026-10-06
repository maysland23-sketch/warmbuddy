'use strict';

// Read-only preview for two exported WarmBuddy stores.
// It prints metadata and IDs only; it never writes either input file.

const fs = require('node:fs');

const PROJECT_ID = 'pmqmkvxp9kogv';
const CHAT_IDS = ['cmqmkw3du596v', 'cmr3nolv7rivs', 'cmrrp86t8k9e6'];
const SAMPLE_LIMIT = 5;

function usage() {
  console.error('Usage: node tools/preview-chat-order-repair.js <phone-export.json> <computer-export.json>');
  process.exitCode = 2;
}

function readStore(filePath) {
  const exported = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Object.prototype.hasOwnProperty.call(exported, 'warmbuddy-store')) {
    throw new Error(`missing warmbuddy-store in ${filePath}`);
  }
  const raw = exported['warmbuddy-store'];
  const store = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!store || !Array.isArray(store.projects)) {
    throw new Error(`warmbuddy-store has no projects array in ${filePath}`);
  }
  return store;
}

function findChat(store, chatId) {
  const project = findProject(store);
  return project && Array.isArray(project.chats)
    ? project.chats.find(chat => chat && chat.id === chatId)
    : null;
}

function findProject(store) {
  return store.projects.find(project => project && project.id === PROJECT_ID) || null;
}

function validId(message) {
  return message && typeof message.id === 'string' && message.id.trim() ? message.id : null;
}

function idStats(messages) {
  const ids = messages.map(validId);
  const present = ids.filter(Boolean);
  const counts = new Map();
  present.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  return {
    total: messages.length,
    uniqueIds: counts.size,
    duplicateIdCount: present.length - counts.size,
    missingIdCount: ids.filter(id => !id).length,
    ids,
    set: new Set(counts.keys())
  };
}

function sample(values) {
  return values.slice(0, SAMPLE_LIMIT);
}

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value));
}

function messagesById(messages) {
  const result = new Map();
  messages.forEach(message => {
    const id = validId(message);
    if (id && !result.has(id)) result.set(id, message);
  });
  return result;
}

function orderedCommonIds(messages, commonIds) {
  return messages.map(validId).filter(id => id && commonIds.has(id));
}

function positionChanges(phoneCommonIds, computerCommonIds) {
  const phonePositions = new Map(phoneCommonIds.map((id, index) => [id, index]));
  const computerPositions = new Map(computerCommonIds.map((id, index) => [id, index]));
  const changed = [];
  for (const id of phonePositions.keys()) {
    if (phonePositions.get(id) !== computerPositions.get(id)) changed.push(id);
  }
  return changed;
}

function previewWithComputerOnlyAnchors(computerMessages, phoneCommonIds, computerOnlyIds) {
  const computerOnly = new Set(computerOnlyIds);
  const commonSlots = computerMessages
    .map((message, index) => ({ id: validId(message), index }))
    .filter(entry => entry.id && !computerOnly.has(entry.id))
    .map(entry => entry.index);
  if (commonSlots.length !== phoneCommonIds.length) return null;

  const preview = computerMessages.map(validId);
  commonSlots.forEach((slot, index) => { preview[slot] = phoneCommonIds[index]; });
  return preview;
}

function multiset(values) {
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  return counts;
}

function sameMultiset(left, right) {
  const a = multiset(left);
  const b = multiset(right);
  if (a.size !== b.size) return false;
  for (const [value, count] of a) if (b.get(value) !== count) return false;
  return true;
}

function dividerIds(messages) {
  return messages.map(validId).filter((id, index) => id && messages[index].contentType === 'dateDivider');
}

function compareChat(phoneMessages, computerMessages) {
  const phoneStats = idStats(phoneMessages);
  const computerStats = idStats(computerMessages);
  const invalidIdIntegrity = phoneStats.duplicateIdCount > 0 || phoneStats.missingIdCount > 0 ||
    computerStats.duplicateIdCount > 0 || computerStats.missingIdCount > 0;
  const phoneOnlyIds = setDifference(phoneStats.set, computerStats.set);
  const computerOnlyIds = setDifference(computerStats.set, phoneStats.set);
  const commonIds = new Set([...phoneStats.set].filter(id => computerStats.set.has(id)));
  const phoneCommonIds = orderedCommonIds(phoneMessages, commonIds);
  const computerCommonIds = orderedCommonIds(computerMessages, commonIds);
  const phoneById = messagesById(phoneMessages);
  const computerById = messagesById(computerMessages);
  const fieldChanges = { text: 0, date: 0, time: 0, createdAt: 0 };

  for (const id of commonIds) {
    const phoneMessage = phoneById.get(id);
    const computerMessage = computerById.get(id);
    for (const field of Object.keys(fieldChanges)) {
      if ((phoneMessage && phoneMessage[field]) !== (computerMessage && computerMessage[field])) {
        fieldChanges[field]++;
      }
    }
  }

  const phoneDividers = dividerIds(phoneMessages);
  const computerDividers = dividerIds(computerMessages);
  const commonDividerIds = new Set(phoneDividers.filter(id => computerDividers.includes(id)));
  const dividerOrderChanges = positionChanges(
    phoneDividers.filter(id => commonDividerIds.has(id)),
    computerDividers.filter(id => commonDividerIds.has(id))
  );
  const previewIds = invalidIdIntegrity
    ? null
    : previewWithComputerOnlyAnchors(computerMessages, phoneCommonIds, computerOnlyIds);
  const computerOnlyPositions = computerMessages
    .map((message, index) => ({ id: validId(message), index }))
    .filter(entry => entry.id && computerOnlyIds.includes(entry.id));
  const previewAdjustmentIds = previewIds
    ? previewIds.map((id, index) => id && id !== computerStats.ids[index] && commonIds.has(id) ? id : null).filter(Boolean)
    : [];

  return {
    status: invalidIdIntegrity ? 'invalid-id-integrity' : 'ok',
    idIntegrity: {
      valid: !invalidIdIntegrity,
      reason: invalidIdIntegrity
        ? 'duplicate or missing message IDs; candidate order is refused'
        : 'all message IDs are present and unique'
    },
    phone: {
      total: phoneStats.total,
      uniqueIdCount: phoneStats.uniqueIds,
      duplicateIdCount: phoneStats.duplicateIdCount,
      missingIdCount: phoneStats.missingIdCount,
      dateDividerCount: phoneDividers.length
    },
    computer: {
      total: computerStats.total,
      uniqueIdCount: computerStats.uniqueIds,
      duplicateIdCount: computerStats.duplicateIdCount,
      missingIdCount: computerStats.missingIdCount,
      dateDividerCount: computerDividers.length
    },
    idSet: {
      commonCount: commonIds.size,
      phoneOnlyCount: phoneOnlyIds.length,
      phoneOnlySample: sample(phoneOnlyIds),
      computerOnlyCount: computerOnlyIds.length,
      computerOnlySample: sample(computerOnlyIds),
      previewPreservesComputerIdSet: previewIds ? sameMultiset(previewIds, computerStats.ids) : false
    },
    commonOrderReference: {
      source: 'phone common-ID order only; not proof of deletion or cross-device synchronization',
      changedPositionCount: positionChanges(phoneCommonIds, computerCommonIds).length,
      adjustmentCount: previewAdjustmentIds.length,
      adjustmentSample: sample(previewAdjustmentIds),
      phoneCommonCount: phoneCommonIds.length,
      computerCommonCount: computerCommonIds.length
    },
    commonFieldChanges: fieldChanges,
    dateDividerChanges: {
      phoneCount: phoneDividers.length,
      computerCount: computerDividers.length,
      commonCount: commonDividerIds.size,
      phoneOnlyCount: phoneDividers.filter(id => !computerDividers.includes(id)).length,
      computerOnlyCount: computerDividers.filter(id => !phoneDividers.includes(id)).length,
      commonOrderChangeCount: dividerOrderChanges.length
    },
    computerOnlyRule: {
      rule: 'retain computer-only rows, their original positions, and their original relative order; never delete or rewrite them',
      positionCount: computerOnlyPositions.length,
      positionsPreserved: !!previewIds && computerOnlyPositions.every(entry => previewIds[entry.index] === entry.id),
      pendingConfirmation: computerOnlyIds.length > 0,
      conflict: computerOnlyIds.length > 0
        ? 'semantic placement against phone-only history is not inferable; preview keeps current computer anchors and does not import phone-only rows'
        : 'none'
    },
    preview: {
      generated: !!previewIds,
      applied: false,
      bodyOrTimeOverwritten: false,
      pendingConfirmation: !previewIds || computerOnlyIds.length > 0,
      reason: invalidIdIntegrity
        ? 'duplicate or missing message IDs; no candidate order generated'
        : !previewIds
        ? 'common-ID slot count does not match; no candidate order generated'
        : computerOnlyIds.length > 0
          ? 'computer-only anchors remain fixed; relative placement against phone-only rows is unresolved'
          : 'candidate only reorders common IDs to the phone reference order'
    }
  };
}

if (require.main === module) {
  const [phonePath, computerPath] = process.argv.slice(2);
  if (!phonePath || !computerPath) {
    usage();
  } else {
    try {
      const phoneStore = readStore(phonePath);
      const computerStore = readStore(computerPath);
      const phoneProject = findProject(phoneStore);
      const computerProject = findProject(computerStore);
      if (!phoneProject || !computerProject) {
        console.log(JSON.stringify({
          mode: 'read-only-order-repair-preview',
          projectId: PROJECT_ID,
          status: 'project-mismatch',
          sources: {
            phoneProjectPresent: !!phoneProject,
            computerProjectPresent: !!computerProject
          },
          preview: { generated: false, applied: false, reason: 'target project missing from one or both sources' },
          sessions: {}
        }, null, 2));
        return;
      }
      const sessions = {};
      for (const chatId of CHAT_IDS) {
        const phoneChat = findChat(phoneStore, chatId);
        const computerChat = findChat(computerStore, chatId);
        if (!phoneChat || !Array.isArray(phoneChat.messages) || !computerChat || !Array.isArray(computerChat.messages)) {
          sessions[chatId] = {
            status: 'source-missing',
            phone: phoneChat ? 'present' : 'missing',
            computer: computerChat ? 'present' : 'missing',
            note: 'not treated as an empty array; no preview generated'
          };
          continue;
        }
        sessions[chatId] = compareChat(phoneChat.messages, computerChat.messages);
      }
      console.log(JSON.stringify({ mode: 'read-only-order-repair-preview', projectId: PROJECT_ID, sessions }, null, 2));
    } catch (error) {
      console.error(`[read-only-preview-error] ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { compareChat, readStore };
