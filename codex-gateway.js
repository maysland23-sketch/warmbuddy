const DEFAULT_CODEX_GATEWAY_TIMEOUT_MS = 150000;
const MAX_CODEX_GATEWAY_TIMEOUT_MS = 150000;
const MAX_CODEX_PROMPT_BYTES = 32768;
const MAX_CODEX_BODY_BYTES = 65536;
const MAX_CODEX_GATEWAY_OUTPUT_BYTES = 4 * 1024 * 1024;
// The Gateway's 4 MiB contract covers its total stdout/stderr output, not pure
// assistant text. Allow bounded SSE/JSON framing conversion overhead while
// retaining neither unbounded event data nor an unbounded message list.
const MAX_CODEX_SSE_INPUT_BYTES = MAX_CODEX_GATEWAY_OUTPUT_BYTES + 512 * 1024;
const MAX_CODEX_MESSAGE_COUNT = 4096;
const MAX_CODEX_TOTAL_OUTPUT_BYTES = MAX_CODEX_GATEWAY_OUTPUT_BYTES;
const MAX_CODEX_EVENT_BYTES = MAX_CODEX_GATEWAY_OUTPUT_BYTES + 64 * 1024;
const MAX_CODEX_SSE_BUFFER_BYTES = MAX_CODEX_EVENT_BYTES + 64 * 1024;
const MAX_CODEX_ERROR_BODY_BYTES = 64 * 1024;
const CODEX_SESSION_ID_PATTERN = /^gs_[0-9a-f]{64}$/;
const CODEX_GATEWAY_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CODEX_EVENT_TYPES = new Set(['session', 'status', 'message', 'error', 'completion']);
const CODEX_UPSTREAM_ERROR_CODES = new Map([
  ['BUSY', 'BUSY'],
  ['UNKNOWN_SESSION', 'UNKNOWN_SESSION'],
  ['SESSION_ACTIVE', 'SESSION_ACTIVE'],
  ['UNAUTHORIZED', 'CODEX_GATEWAY_AUTH_FAILED'],
  ['FORBIDDEN', 'CODEX_GATEWAY_AUTH_FAILED']
]);

const CODEX_ERROR_MESSAGES = Object.freeze({
  CODEX_GATEWAY_NOT_CONFIGURED: 'Codex Gateway is not configured',
  CODEX_GATEWAY_AUTH_FAILED: 'Codex Gateway authentication failed',
  CODEX_GATEWAY_UNAVAILABLE: 'Codex Gateway unavailable',
  CODEX_GATEWAY_TIMEOUT: 'Codex Gateway timed out',
  CODEX_GATEWAY_ABORTED: 'Codex request cancelled',
  CODEX_GATEWAY_INVALID_RESPONSE: 'Codex Gateway returned an invalid response',
  CODEX_GATEWAY_INCOMPLETE: 'Codex response ended before completion',
  CODEX_GATEWAY_FAILED: 'Codex execution failed',
  CODEX_GATEWAY_REJECTED: 'Codex Gateway rejected the request',
  CODEX_INVALID_REQUEST: 'Invalid Codex request',
  CODEX_INVALID_PROMPT: 'Invalid Codex prompt',
  CODEX_PROMPT_TOO_LARGE: 'Codex prompt is too large',
  CODEX_INVALID_SESSION: 'Invalid Codex session',
  CODEX_SESSION_MISMATCH: 'Codex session mismatch',
  CODEX_MISSING_SESSION: 'Codex did not return a session id',
  BUSY: 'Codex Gateway is busy',
  UNKNOWN_SESSION: 'Codex session is unknown',
  SESSION_ACTIVE: 'Codex session is active'
});

class CodexGatewayError extends Error {
  constructor(message, { status = 502, code = 'CODEX_GATEWAY_UNAVAILABLE' } = {}) {
    super(message);
    this.name = 'CodexGatewayError';
    this.status = status;
    this.code = code;
  }
}

function publicMessage(code, fallback) {
  return CODEX_ERROR_MESSAGES[code] || fallback || 'Codex Gateway request failed';
}

function createCodexError(code, status, fallback) {
  return new CodexGatewayError(publicMessage(code, fallback), { code, status });
}

function normalizeBaseUrl(value, { allowHttpLoopback = false } = {}) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowHttpLoopback && loopback && url.protocol === 'http:')) {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  if (url.username || url.password) {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeTimeout(value) {
  const raw = value === undefined ? DEFAULT_CODEX_GATEWAY_TIMEOUT_MS : Number(value);
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > MAX_CODEX_GATEWAY_TIMEOUT_MS) {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  return raw;
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !CODEX_SESSION_ID_PATTERN.test(sessionId)) {
    throw createCodexError('CODEX_INVALID_SESSION', 400);
  }
  return sessionId;
}

function validateCodexPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw createCodexError('CODEX_INVALID_PROMPT', 400);
  }
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > MAX_CODEX_PROMPT_BYTES) {
    throw createCodexError('CODEX_PROMPT_TOO_LARGE', 413);
  }
  return prompt;
}

function validateCodexRequest(prompt, sessionId) {
  const normalizedPrompt = validateCodexPrompt(prompt);
  let normalizedSessionId;
  if (sessionId !== undefined) normalizedSessionId = assertSessionId(sessionId);
  return { prompt: normalizedPrompt, sessionId: normalizedSessionId };
}

function serializeCodexRequest(prompt, sessionId) {
  const request = validateCodexRequest(prompt, sessionId);
  const body = JSON.stringify(request.sessionId === undefined
    ? { prompt: request.prompt }
    : { prompt: request.prompt, sessionId: request.sessionId });
  if (Buffer.byteLength(body, 'utf8') > MAX_CODEX_BODY_BYTES) {
    throw createCodexError('CODEX_GATEWAY_REJECTED', 413);
  }
  return body;
}

function normalizeUpstreamCode(value) {
  return CODEX_UPSTREAM_ERROR_CODES.get(String(value || '')) || null;
}

function statusForCode(code) {
  if (code === 'BUSY') return 409;
  if (code === 'UNKNOWN_SESSION') return 404;
  if (code === 'SESSION_ACTIVE') return 409;
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return 502;
  return 502;
}

function isContentType(response, expected) {
  const value = response?.headers?.get?.('content-type');
  if (!value) return false;
  return value.split(';', 1)[0].trim().toLowerCase() === expected;
}

async function readResponseBodyLimited(response, maxBytes) {
  let reader = null;
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) return { tooLarge: true, text: null };
          chunks.push(Buffer.from(value));
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
      try {
        return {
          tooLarge: false,
          text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        };
      } catch {
        return { tooLarge: false, text: null };
      }
    } else {
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { tooLarge: true, text: null };
      return { tooLarge: false, text: raw };
    }
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}

async function readControlledErrorCode(response) {
  const body = await readResponseBodyLimited(response, MAX_CODEX_ERROR_BODY_BYTES);
  if (body.tooLarge || !body.text || !isContentType(response, 'application/json')) return null;
  try {
    const payload = JSON.parse(body.text);
    return normalizeUpstreamCode(payload && payload.error);
  } catch {}
  return null;
}

function mapHttpError(status, code) {
  if (status === 401 || status === 403) {
    return createCodexError('CODEX_GATEWAY_AUTH_FAILED', 502);
  }
  if (code) return createCodexError(code, statusForCode(code));
  return createCodexError(status >= 500 ? 'CODEX_GATEWAY_UNAVAILABLE' : 'CODEX_GATEWAY_REJECTED', 502);
}

function parseEventPayload(eventName, rawData) {
  if (!rawData || Buffer.byteLength(rawData, 'utf8') > MAX_CODEX_EVENT_BYTES) {
    throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
  }
  let payload;
  try { payload = JSON.parse(rawData); } catch {
    throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
  }
  return payload;
}

async function consumeCodexSse(body, { expectedSessionId, onEvent, onHeartbeat } = {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let currentSessionId = expectedSessionId;
  let completed = false;
  let completionStatus = null;
  let inputBytes = 0;
  const messages = [];

  const dispatch = async () => {
    if (!eventName && dataLines.length === 0) return;
    if (!CODEX_EVENT_TYPES.has(eventName) || dataLines.length === 0) {
      throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
    }
    const payload = parseEventPayload(eventName, dataLines.join('\n'));
    let event;

    if (eventName === 'session') {
      if (typeof payload.sessionId !== 'string' || !CODEX_SESSION_ID_PATTERN.test(payload.sessionId)) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      const sessionId = payload.sessionId;
      if (currentSessionId && sessionId !== currentSessionId) {
        throw createCodexError('CODEX_SESSION_MISMATCH', 502);
      }
      currentSessionId = sessionId;
      event = { type: 'session', payload: { sessionId }, sessionId };
    } else if (eventName === 'status') {
      if (payload.status !== 'running') {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      event = { type: 'status', payload: { status: 'running' } };
    } else if (eventName === 'message') {
      if (typeof payload.text !== 'string') {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      if (messages.length >= MAX_CODEX_MESSAGE_COUNT) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      messages.push(payload.text);
      event = { type: 'message', payload: { text: payload.text }, text: payload.text };
    } else if (eventName === 'error') {
      const code = normalizeUpstreamCode(payload.code);
      if (!code) throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      event = { type: 'error', payload: { code }, code };
      eventName = '';
      dataLines = [];
      await onEvent?.(event);
      throw createCodexError(code, statusForCode(code));
    } else if (eventName === 'completion') {
      if (payload.status !== 'completed' && payload.status !== 'failed') {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      completionStatus = payload.status;
      completed = true;
      event = { type: 'completion', payload: { status: payload.status } };
    }

    eventName = '';
    dataLines = [];
    await onEvent?.(event);
  };

  const processLine = async line => {
    if (line.startsWith(':')) {
      await onHeartbeat?.(line.slice(1).trim());
      return;
    }
    if (!line) {
      await dispatch();
      return;
    }
    if (line.startsWith('event:')) {
      if (eventName || dataLines.length > 0) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      eventName = line.slice('event:'.length).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      if (Buffer.byteLength(dataLines.join('\n'), 'utf8') > MAX_CODEX_EVENT_BYTES) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      return;
    }
    throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      inputBytes += value.byteLength;
      if (inputBytes > MAX_CODEX_SSE_INPUT_BYTES) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_CODEX_SSE_BUFFER_BYTES) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      let newlineIndex;
      while (!completed && (newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        await processLine(line);
      }
    }

    if (!completed) {
      try { buffer += decoder.decode(); } catch {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
      if (buffer || eventName || dataLines.length > 0) {
        throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }

  if (!completed) throw createCodexError('CODEX_GATEWAY_INCOMPLETE', 502);
  if (completionStatus !== 'completed') throw createCodexError('CODEX_GATEWAY_FAILED', 502);
  return { sessionId: currentSessionId || null, messages, completed: true };
}

function createAbortContext(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const abortFromCaller = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    externallyAborted: () => externallyAborted,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };
}

function createCodexGatewayClient({
  baseUrl = process.env.CODEX_GATEWAY_URL,
  token = process.env.CODEX_GATEWAY_TOKEN,
  timeoutMs = process.env.CODEX_GATEWAY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  allowHttpLoopback = false
} = {}) {
  const gatewayUrl = normalizeBaseUrl(baseUrl, { allowHttpLoopback });
  const gatewayToken = String(token || '').trim();
  if (!CODEX_GATEWAY_TOKEN_PATTERN.test(gatewayToken)) {
    throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  }
  if (typeof fetchImpl !== 'function') throw createCodexError('CODEX_GATEWAY_NOT_CONFIGURED', 503);
  const timeout = normalizeTimeout(timeoutMs);

  return {
    async run({ prompt, sessionId, signal, onEvent, onHeartbeat } = {}) {
      const request = validateCodexRequest(prompt, sessionId);
      const body = serializeCodexRequest(request.prompt, request.sessionId);
      const abortContext = createAbortContext(signal, timeout);
      try {
        const response = await fetchImpl(`${gatewayUrl}/v1/agent/stream`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${gatewayToken}`
          },
          body,
          signal: abortContext.signal
        });
        if (!response || typeof response.ok !== 'boolean') {
          throw createCodexError('CODEX_GATEWAY_UNAVAILABLE', 502);
        }
        if (!response.ok) {
          const code = await readControlledErrorCode(response);
          throw mapHttpError(response.status, code);
        }
        if (!isContentType(response, 'text/event-stream')) {
          await readResponseBodyLimited(response, MAX_CODEX_ERROR_BODY_BYTES);
          throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
        }
        const result = await consumeCodexSse(response.body, {
          expectedSessionId: request.sessionId,
          onEvent,
          onHeartbeat
        });
        if (!request.sessionId && !result.sessionId) {
          throw createCodexError('CODEX_MISSING_SESSION', 502);
        }
        return result;
      } catch (error) {
        if (error instanceof CodexGatewayError) throw error;
        if (abortContext.externallyAborted() && !abortContext.timedOut()) {
          throw createCodexError('CODEX_GATEWAY_ABORTED', 499);
        }
        if (abortContext.timedOut() || error?.name === 'AbortError') {
          throw createCodexError('CODEX_GATEWAY_TIMEOUT', 504);
        }
        throw createCodexError('CODEX_GATEWAY_UNAVAILABLE', 502);
      } finally {
        abortContext.cleanup();
      }
    },

    async deleteSession(sessionId, { signal } = {}) {
      const validSessionId = assertSessionId(sessionId);
      const abortContext = createAbortContext(signal, timeout);
      try {
        const response = await fetchImpl(`${gatewayUrl}/v1/sessions/${validSessionId}`, {
          method: 'DELETE',
          redirect: 'error',
          headers: { authorization: `Bearer ${gatewayToken}` },
          signal: abortContext.signal
        });
        if (!response || typeof response.ok !== 'boolean') {
          throw createCodexError('CODEX_GATEWAY_UNAVAILABLE', 502);
        }
        if (!response.ok) {
          const code = await readControlledErrorCode(response);
          throw mapHttpError(response.status, code);
        }
        if (response.status !== 200 || !isContentType(response, 'application/json')) {
          await readResponseBodyLimited(response, MAX_CODEX_ERROR_BODY_BYTES);
          throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
        }
        const body = await readResponseBodyLimited(response, MAX_CODEX_ERROR_BODY_BYTES);
        if (body.tooLarge || !body.text) {
          throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
        }
        let payload;
        try {
          payload = JSON.parse(body.text);
        } catch {
          throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.status !== 'deleted') {
          throw createCodexError('CODEX_GATEWAY_INVALID_RESPONSE', 502);
        }
        return { deleted: true };
      } catch (error) {
        if (error instanceof CodexGatewayError) throw error;
        if (abortContext.externallyAborted() && !abortContext.timedOut()) {
          throw createCodexError('CODEX_GATEWAY_ABORTED', 499);
        }
        if (abortContext.timedOut() || error?.name === 'AbortError') {
          throw createCodexError('CODEX_GATEWAY_TIMEOUT', 504);
        }
        throw createCodexError('CODEX_GATEWAY_UNAVAILABLE', 502);
      } finally {
        abortContext.cleanup();
      }
    }
  };
}

module.exports = {
  CODEX_ERROR_MESSAGES,
  CODEX_GATEWAY_TOKEN_PATTERN,
  CODEX_SESSION_ID_PATTERN,
  DEFAULT_CODEX_GATEWAY_TIMEOUT_MS,
  MAX_CODEX_BODY_BYTES,
  MAX_CODEX_GATEWAY_OUTPUT_BYTES,
  MAX_CODEX_MESSAGE_COUNT,
  MAX_CODEX_PROMPT_BYTES,
  MAX_CODEX_SSE_INPUT_BYTES,
  MAX_CODEX_TOTAL_OUTPUT_BYTES,
  CodexGatewayError,
  consumeCodexSse,
  createCodexGatewayClient,
  serializeCodexRequest,
  validateCodexRequest
};
