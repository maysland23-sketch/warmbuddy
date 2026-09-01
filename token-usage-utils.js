function asCount(value) {
  var number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function firstCount() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null) return asCount(arguments[i]);
  }
  return 0;
}

function normalizeUsage(usage) {
  usage = usage || {};
  var inputTokens = firstCount(usage.input_tokens, usage.prompt_tokens);
  var outputTokens = firstCount(usage.output_tokens, usage.completion_tokens);
  var promptDetails = usage.prompt_tokens_details || {};
  var cacheReadTokens = firstCount(
    usage.cache_read_input_tokens,
    usage.cached_input_tokens,
    promptDetails.cached_tokens
  );
  var cacheWriteTokens = firstCount(
    usage.cache_creation_input_tokens,
    usage.cache_write_input_tokens
  );
  var totalTokens = usage.total_tokens === undefined || usage.total_tokens === null
    ? inputTokens + outputTokens
    : asCount(usage.total_tokens);

  return {
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    totalTokens: totalTokens,
    isEstimated: false
  };
}

function estimateUsage(inputTokens, outputTokens) {
  var input = asCount(inputTokens);
  var output = asCount(outputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: input + output,
    isEstimated: true
  };
}

function createTokenUsageEvent(input) {
  input = input || {};
  var usage = input.isEstimated
    ? estimateUsage(input.inputTokens, input.outputTokens)
    : input.usage
      ? normalizeUsage(input.usage)
      : estimateUsage(input.inputTokens, input.outputTokens);
  var createdAt = input.createdAt || new Date().toISOString();

  return {
    id: input.id || ('tok_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
    project_id: input.projectId || '',
    window_id: input.windowId || '',
    interaction_id: input.interactionId || '',
    action_type: input.actionType || 'chat',
    stage: input.stage || 'single',
    model: input.model || 'unknown',
    provider: input.provider || 'unknown',
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens,
    is_estimated: usage.isEstimated,
    created_at: createdAt,
    metadata: input.metadata || {}
  };
}

module.exports = {
  normalizeUsage,
  estimateUsage,
  createTokenUsageEvent
};
