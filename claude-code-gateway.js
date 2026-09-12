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
    async run({ conversationId, prompt, signal }) {
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

      let response;
      try {
        response = await fetchImpl(`${gatewayUrl}/v1/agent/run`, {
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
      } catch (error) {
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

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AgentGatewayError('Agent Gateway returned invalid JSON', {
          status: 502,
          code: 'AGENT_GATEWAY_INVALID_RESPONSE',
          cause: error
        });
      }

      if (!response.ok || payload?.ok === false) {
        throw new AgentGatewayError(
          response.status >= 500 ? 'Agent Gateway upstream failure' : 'Agent Gateway rejected the request',
          {
            status: response.status >= 400 ? response.status : 502,
            code: String(payload?.code || 'AGENT_GATEWAY_UPSTREAM_ERROR')
          }
        );
      }

      const content = typeof payload?.result === 'string'
        ? payload.result
        : typeof payload?.result?.content === 'string'
          ? payload.result.content
          : typeof payload?.result?.text === 'string'
            ? payload.result.text
            : '';
      if (!content) {
        throw new AgentGatewayError('Agent Gateway returned no assistant content', {
          status: 502,
          code: 'AGENT_GATEWAY_INVALID_RESPONSE'
        });
      }

      return {
        content,
        sessionId: payload.sessionId || null,
        usage: payload.usage || null,
        resumed: Boolean(payload.resumed)
      };
    }
  };
}

module.exports = {
  AGENT_GATEWAY_PROJECT_ID,
  DEFAULT_AGENT_GATEWAY_TIMEOUT_MS,
  AgentGatewayError,
  createAgentGatewayClient
};
