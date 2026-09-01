const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUsage,
  createTokenUsageEvent,
  estimateUsage
} = require('../token-usage-utils');

test('normalizes Anthropic usage fields and cache counts', () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 1200,
    output_tokens: 240,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40
  }), {
    inputTokens: 1200,
    outputTokens: 240,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    totalTokens: 1440,
    isEstimated: false
  });
});

test('normalizes OpenAI usage fields and cached prompt details', () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 1800,
    completion_tokens: 160,
    total_tokens: 1960,
    prompt_tokens_details: { cached_tokens: 500 }
  }), {
    inputTokens: 1800,
    outputTokens: 160,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    totalTokens: 1960,
    isEstimated: false
  });
});

test('creates an idempotent event with interaction and stage metadata', () => {
  const event = createTokenUsageEvent({
    id: 'evt-1',
    projectId: 'p1',
    windowId: 'c1',
    interactionId: 'int-1',
    actionType: 'mcp',
    stage: 'followup',
    model: 'mock-model',
    provider: 'openai',
    usage: { prompt_tokens: 2400, completion_tokens: 200, total_tokens: 2600 },
    createdAt: '2026-09-01T12:00:00.000Z',
    metadata: { toolCount: 1 }
  });

  assert.deepEqual(event, {
    id: 'evt-1',
    project_id: 'p1',
    window_id: 'c1',
    interaction_id: 'int-1',
    action_type: 'mcp',
    stage: 'followup',
    model: 'mock-model',
    provider: 'openai',
    input_tokens: 2400,
    output_tokens: 200,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 2600,
    is_estimated: false,
    created_at: '2026-09-01T12:00:00.000Z',
    metadata: { toolCount: 1 }
  });
});

test('marks fallback token counts as estimated', () => {
  assert.deepEqual(estimateUsage(120, 80), {
    inputTokens: 120,
    outputTokens: 80,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 200,
    isEstimated: true
  });
});
