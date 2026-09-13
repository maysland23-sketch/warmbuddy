const AGENT_GATEWAY_PROJECT_ID = 'warmbuddy-test';
const DEFAULT_AGENT_GATEWAY_TIMEOUT_MS = 120000;

class AgentGatewayError extends Error {
  constructor(message, { status = 502, code = 'AGENT_GATEWAY_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AgentGatewayError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) {
    throw new AgentGatewayError('Agent Gateway is not configured', {
      status: 503,
      code: 'AGENT_GATEWAY_NOT_CONFIGURED'
    });
  }
  try {
    return new URL(raw).toString().replace(/\/$/, '');
  } catch (error) {
    throw new AgentGatewayError('Agent Gateway URL is invalid', {
      status: 503,
      code: 'AGENT_GATEWAY_NOT_CONFIGURED',
      cause: error
    });
  }
}

const AGENT_GATEWAY_EVENT_TYPES = new Set(['start', 'delta', 'result', 'error', 'done']);

function parseGatewayEventData(rawData) {
  if (!rawData) return null;
  try {
    return JSON.parse(rawData);
  } catch (error) {
    throw new AgentGatewayError('Agent Gateway returned invalid SSE data', {
      status: 502,
      code: 'AGENT_GATEWAY_INVALID_RESPONSE',
      cause: error
    });
  }
}

function gatewayEventText(payload) {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.result === 'string') return payload.result;
  return '';
}

function gatewayEventError(payload) {
  if (typeof payload === 'string') return { message: payload };
  if (!payload || typeof payload !== 'object') return {};
  return {
    message: payload.error || payload.message,
    code: payload.code
  };
}

async function consumeGatewaySse(body, onEvent, onHeartbeat) {
  if (!body || typeof body.getReader !== 'function') {
    throw new AgentGatewayError('Agent Gateway returned no SSE body', {
      status: 502,
      code: 'AGENT_GATEWAY_INVALID_RESPONSE'
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let doneSeen = false;
  let streamedContent = '';
  let resultContent = '';
  let resultPayload = null;

  const dispatch = () => {
    if (!eventName && dataLines.length === 0) return;
    if (!AGENT_GATEWAY_EVENT_TYPES.has(eventName)) {
      throw new AgentGatewayError('Agent Gateway returned an invalid SSE event', {
        status: 502,
        code: 'AGENT_GATEWAY_INVALID_RESPONSE'
      });
    }

    const payload = parseGatewayEventData(dataLines.join('\n'));
    const event = { type: eventName, payload };

    if (eventName === 'delta' || eventName === 'result') {
      const text = gatewayEventText(payload);
      if (eventName === 'delta' && !text) {
        throw new AgentGatewayError('Agent Gateway returned an empty delta', {
          status: 502,
          code: 'AGENT_GATEWAY_INVALID_RESPONSE'
        });
      }
      event.text = text;
      if (eventName === 'delta') streamedContent += text;
      else {
        resultContent = text;
        resultPayload = payload;
      }
    } else if (eventName === 'error') {
      const upstreamError = gatewayEventError(payload);
      throw new AgentGatewayError(upstreamError.message || 'Agent Gateway upstream failure', {
        status: 502,
        code: String(upstreamError.code || 'AGENT_GATEWAY_UPSTREAM_ERROR')
      });
    } else if (eventName === 'done') {
      doneSeen = true;
    }

    onEvent?.(event);
    eventName = '';
    dataLines = [];
  };

  const processLine = line => {
    if (line.startsWith(':')) {
      if (line.slice(1).trim() === 'heartbeat') onHeartbeat?.();
      return;
    }
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      return;
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  };

  while (!doneSeen) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      processLine(line);
      if (doneSeen) break;
    }
  }

  if (!doneSeen) {
    buffer += decoder.decode();
    if (buffer) processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    if (eventName || dataLines.length > 0) dispatch();
  }
  if (!doneSeen) {
    throw new AgentGatewayError('Agent Gateway SSE ended before done', {
      status: 502,
      code: 'AGENT_GATEWAY_INVALID_RESPONSE'
    });
  }

  return {
    content: resultContent || streamedContent,
    sessionId: resultPayload?.sessionId || null,
    usage: resultPayload?.usage || null,
    resumed: Boolean(resultPayload?.resumed)
  };
}

function createAgentGatewayClient({
  baseUrl = process.env.AGENT_GATEWAY_URL,
  token = process.env.AGENT_GATEWAY_TOKEN,
  timeoutMs = process.env.AGENT_GATEWAY_TIMEOUT_MS || DEFAULT_AGENT_GATEWAY_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const gatewayUrl = normalizeBaseUrl(baseUrl);
  const gatewayToken = String(token || '').trim();
  if (!gatewayToken) {
    throw new AgentGatewayError('Agent Gateway token is not configured', {
      status: 503,
      code: 'AGENT_GATEWAY_NOT_CONFIGURED'
    });
  }
  if (typeof fetchImpl !== 'function') {
    throw new AgentGatewayError('Agent Gateway fetch is unavailable', {
      status: 503,
      code: 'AGENT_GATEWAY_NOT_CONFIGURED'
    });
  }

  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_AGENT_GATEWAY_TIMEOUT_MS);

  return {
    async run({ conversationId, prompt, signal, onEvent, onHeartbeat }) {
      if (!String(conversationId || '').trim()) {
        throw new AgentGatewayError('Missing Gateway conversation id', {
          status: 400,
          code: 'INVALID_AGENT_GATEWAY_REQUEST'
        });
      }
      if (!String(prompt || '').trim()) {
        throw new AgentGatewayError('Missing Gateway prompt', {
          status: 400,
          code: 'INVALID_AGENT_GATEWAY_REQUEST'
        });
      }

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
      }, timeout);

      try {
        const response = await fetchImpl(`${gatewayUrl}/v1/agent/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${gatewayToken}`
          },
          body: JSON.stringify({
            projectId: AGENT_GATEWAY_PROJECT_ID,
            conversationId: String(conversationId),
            prompt: String(prompt),
            resume: false
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const upstreamBody = await response.text();
          console.error('[agent-gateway] upstream non-2xx response', {
            status: response.status,
            statusText: response.statusText,
            body: upstreamBody,
            AGENT_GATEWAY_URL: gatewayUrl,
            projectId: AGENT_GATEWAY_PROJECT_ID
          });
          let payload = null;
          try { payload = upstreamBody ? JSON.parse(upstreamBody) : null; } catch (error) {}
          throw new AgentGatewayError(
            response.status >= 500 ? 'Agent Gateway upstream failure' : 'Agent Gateway rejected the request',
            {
              status: response.status >= 400 ? response.status : 502,
              code: String(payload?.code || 'AGENT_GATEWAY_UPSTREAM_ERROR')
            }
          );
        }

        const result = await consumeGatewaySse(response.body, onEvent, onHeartbeat);
        if (!result.content) {
          throw new AgentGatewayError('Agent Gateway returned no assistant content', {
            status: 502,
            code: 'AGENT_GATEWAY_INVALID_RESPONSE'
          });
        }
        return result;
      } catch (error) {
        if (error instanceof AgentGatewayError) throw error;
        if (externallyAborted && !timedOut) {
          throw new AgentGatewayError('Agent Gateway request was aborted', {
            status: 499,
            code: 'AGENT_GATEWAY_ABORTED',
            cause: error
          });
        }
        if (timedOut || error?.name === 'AbortError') {
          throw new AgentGatewayError('Agent Gateway request timed out', {
            status: 504,
            code: 'AGENT_GATEWAY_TIMEOUT',
            cause: error
          });
        }
        throw new AgentGatewayError('Agent Gateway request failed', {
          status: 502,
          code: 'AGENT_GATEWAY_UNAVAILABLE',
          cause: error
        });
      } finally {
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', abortFromCaller);
      }
    }
  };
}

module.exports = {
  AGENT_GATEWAY_PROJECT_ID,
  DEFAULT_AGENT_GATEWAY_TIMEOUT_MS,
  AgentGatewayError,
  createAgentGatewayClient
};
