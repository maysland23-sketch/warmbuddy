'use strict';

const MEMORY_VERSION_FIELDS = [
  'updated_at',
  'updatedAt',
  'timestamp',
  'created_at',
  'createdAt',
  'date'
];

function normalizeMemoryId(value) {
  if (value === undefined || value === null) return null;
  const id = String(value);
  return id.length > 0 ? id : null;
}

function parseVersionTimestamp(memory) {
  const sources = [memory, memory && memory.metadata];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of MEMORY_VERSION_FIELDS) {
      const value = source[field];
      if (value === undefined || value === null || value === '') continue;
      const time = Date.parse(String(value));
      if (!Number.isNaN(time)) return time;
    }
  }
  return null;
}

function isNewerCandidate(candidate, current) {
  if (candidate.versionTime !== current.versionTime) {
    if (candidate.versionTime === null) return false;
    if (current.versionTime === null) return true;
    return candidate.versionTime > current.versionTime;
  }
  // With no usable version timestamp, or when timestamps tie, the later
  // occurrence is the deterministic last-write-wins fallback.
  return candidate.index > current.index;
}

function buildMemoryRow(projectId, memory, updatedAt) {
  const id = normalizeMemoryId(memory && memory.id);
  if (id === null) {
    const error = new Error('Each memory must include a non-empty id');
    error.code = 'INVALID_MEMORY_ID';
    throw error;
  }

  return {
    id,
    project_id: projectId,
    content: (memory.content || memory.summary || '').slice(0, 500),
    type: memory.type || 'aem',
    layer: memory.layer || 'ai_emotional',
    starred: memory.starred || false,
    updated_at: updatedAt,
    metadata: memory.metadata || memory
  };
}

/**
 * Convert an API memory batch to database rows and remove duplicate values of
 * the actual memories primary key (`id`). A timestamped newer version wins;
 * otherwise the last occurrence wins. The same helper is used by upsert and
 * full-sync writes so merged client layers cannot produce duplicate rows.
 */
function buildMemoryRows(projectId, memories, updatedAt = new Date().toISOString()) {
  const winners = new Map();

  memories.forEach((memory, index) => {
    if (!memory || typeof memory !== 'object') {
      const error = new Error('Each memory must be an object');
      error.code = 'INVALID_MEMORY';
      throw error;
    }

    const id = normalizeMemoryId(memory.id);
    const candidate = {
      memory,
      index,
      versionTime: parseVersionTimestamp(memory)
    };
    const current = winners.get(id);
    if (!current || isNewerCandidate(candidate, current)) {
      winners.set(id, candidate);
    }
  });

  return Array.from(winners.values(), candidate => (
    buildMemoryRow(projectId, candidate.memory, updatedAt)
  ));
}

module.exports = {
  buildMemoryRows,
  normalizeMemoryId,
  parseVersionTimestamp
};
