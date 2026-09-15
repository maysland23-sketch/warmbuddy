const { createHash, timingSafeEqual } = require('node:crypto');

const RENDER_PROXY_HEADER = 'x-warmbuddy-proxy-secret';
const MIN_SECRET_BYTES = 32;
const SENSITIVE_KEY = /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token|key|credential)$/i;
const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'key', 'api_key', 'apikey', 'access_token', 'auth', 'authorization', 'secret'
]);

function digest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function assertSecret(secret) {
  const value = String(secret || '');
  if (!value) throw new Error('RENDER_PROXY_SECRET is required');
  if (Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(`RENDER_PROXY_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return value;
}

function getHeader(req, name) {
  if (typeof req.get === 'function') return req.get(name);
  const headers = req.headers || {};
  return headers[name.toLowerCase()] || headers[name] || undefined;
}

function createRenderApiGuard({ secret, headerName = RENDER_PROXY_HEADER } = {}) {
  const expectedSecret = assertSecret(secret);
  const expectedDigest = digest(expectedSecret);
  const normalizedHeaderName = String(headerName).toLowerCase();

  return function renderApiGuard(req, res, next) {
    const supplied = getHeader(req, normalizedHeaderName);
    const authorized = supplied !== undefined && supplied !== null &&
      timingSafeEqual(expectedDigest, digest(supplied));
    if (!authorized) {
      return res.status(401).json({
        error: 'Unauthorized',
        code: 'RENDER_API_UNAUTHORIZED'
      });
    }
    return next();
  };
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = sanitizeValue(nested);
  }
  return output;
}

function sanitizeProjectConfigForClient(config) {
  if (!config || typeof config !== 'object') return null;
  const output = {
    hasApiKey: Boolean(config.apiKey && String(config.apiKey).trim())
  };
  if (Object.prototype.hasOwnProperty.call(config, 'enabled')) output.enabled = config.enabled;
  for (const key of ['_desireState', '_userStatus', '_aiStatus']) {
    if (Object.prototype.hasOwnProperty.call(config, key)) {
      output[key] = sanitizeValue(config[key]);
    }
  }
  return output;
}

function sanitizeToolUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function hasConfiguredAuth(auth) {
  if (!auth || typeof auth !== 'object') return false;
  if (auth.configured === true) return true;
  if (!auth.type || auth.type === 'none') return false;
  return Boolean(auth.token || auth.username || auth.password || auth.value || auth.apiKey || auth.accessToken || auth.access_token);
}

function sanitizeToolDefinitionForClient(definition) {
  const source = definition && typeof definition === 'object' ? definition : {};
  const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
  return {
    id: source.id == null ? '' : String(source.id),
    name: source.name == null ? '' : String(source.name),
    description: source.description == null ? '' : String(source.description),
    transport: source.transport == null ? '' : String(source.transport),
    url: sanitizeToolUrl(source.url),
    auth: {
      type: auth.type == null ? 'none' : String(auth.type),
      configured: hasConfiguredAuth(auth)
    }
  };
}

function sanitizeToolDefinitionsForClient(definitions) {
  return Array.isArray(definitions) ? definitions.map(sanitizeToolDefinitionForClient) : [];
}

function normalizeHeaders(input) {
  const output = {};
  new Headers(input || {}).forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
}

function createInternalApiFetch({ origin, secret, fetchImpl = globalThis.fetch } = {}) {
  const expectedSecret = assertSecret(secret);
  const base = new URL(String(origin || ''));
  const headersName = RENDER_PROXY_HEADER;

  return async function internalApiFetch(relativePath, init = {}) {
    if (typeof relativePath !== 'string' || !/^\/api(?:\/|$)/.test(relativePath)) {
      throw new Error('internal API fetch requires a relative /api path');
    }
    const target = new URL(relativePath, base);
    if (target.origin !== base.origin) {
      throw new Error('internal API fetch requires a relative /api path');
    }
    const headers = normalizeHeaders(init.headers);
    headers[headersName] = expectedSecret;
    return fetchImpl(target.toString(), { ...init, headers });
  };
}

module.exports = {
  RENDER_PROXY_HEADER,
  createRenderApiGuard,
  sanitizeProjectConfigForClient,
  sanitizeToolDefinitionForClient,
  sanitizeToolDefinitionsForClient,
  createInternalApiFetch
};
