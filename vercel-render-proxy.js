const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { RENDER_PROXY_HEADER } = require('./render-api-security');

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-none-match', 'last-event-id']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'content-disposition', 'retry-after']);
const DUMMY_ORIGIN = 'http://vercel-proxy.invalid';

function sendJson(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function normalizeRenderOrigin(renderOrigin) {
  if (!renderOrigin) throw new Error('RENDER_ORIGIN is required');
  const origin = new URL(String(renderOrigin));
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('RENDER_ORIGIN must be an HTTP(S) origin');
  }
  return origin;
}

function validateProxySecret(proxySecret) {
  const secret = String(proxySecret || '');
  if (!secret) throw new Error('RENDER_PROXY_SECRET is required');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('RENDER_PROXY_SECRET must be at least 32 bytes');
  }
  return secret;
}

function copyRequestHeaders(req, proxySecret) {
  const headers = {};
  for (const [name, rawValue] of Object.entries(req.headers || {})) {
    const normalizedName = name.toLowerCase();
    if (!REQUEST_HEADERS.has(normalizedName)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    headers[normalizedName] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  headers[RENDER_PROXY_HEADER] = proxySecret;
  return headers;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    }
    function onData(chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        req.resume();
        reject(Object.assign(new Error('Request too large'), { code: 'REQUEST_TOO_LARGE' }));
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function onAborted() {
      onError(Object.assign(new Error('Request aborted'), { code: 'REQUEST_ABORTED' }));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function logRequest(logger, method, pathname, status, startedAt) {
  if (!logger || typeof logger.info !== 'function') return;
  logger.info('[render-proxy]', {
    method,
    path: pathname,
    status,
    durationMs: Date.now() - startedAt
  });
}

function logFailure(logger, method, pathname, code) {
  if (!logger || typeof logger.error !== 'function') return;
  logger.error('[render-proxy]', { method, path: pathname, code });
}

function createVercelRenderProxy({ renderOrigin, proxySecret, fetchImpl = globalThis.fetch, logger = console } = {}) {
  let origin;
  let secret;
  let configurationError = null;
  try {
    origin = normalizeRenderOrigin(renderOrigin);
    secret = validateProxySecret(proxySecret);
  } catch (error) {
    configurationError = error;
  }

  return async function vercelRenderProxy(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const parsed = new URL(req.url || '/', DUMMY_ORIGIN);
    const pathname = parsed.pathname;
    const startedAt = Date.now();

    if (!isApiPath(pathname)) {
      return sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }
    if (!ALLOWED_METHODS.has(method)) {
      return sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    }
    if (configurationError) {
      return sendJson(res, 503, { error: 'Proxy not configured', code: 'PROXY_NOT_CONFIGURED' });
    }

    let body;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      try {
        body = await readRequestBody(req, MAX_BODY_BYTES);
      } catch (error) {
        if (error.code === 'REQUEST_TOO_LARGE') {
          return sendJson(res, 413, { error: 'Request too large', code: 'REQUEST_TOO_LARGE' });
        }
        if (error.code === 'REQUEST_ABORTED') return;
        logFailure(logger, method, pathname, 'REQUEST_READ_FAILED');
        return sendJson(res, 400, { error: 'Invalid request', code: 'REQUEST_READ_FAILED' });
      }
    }

    const target = new URL(pathname + parsed.search, origin);
    const controller = new AbortController();
    const abortIfDisconnected = () => {
      if (!req.complete) controller.abort();
    };
    req.once('aborted', abortIfDisconnected);
    req.once('close', abortIfDisconnected);

    let upstream;
    try {
      const fetchOptions = {
        method,
        headers: copyRequestHeaders(req, secret),
        signal: controller.signal
      };
      if (body !== undefined && body.length > 0) fetchOptions.body = body;
      upstream = await fetchImpl(target.toString(), fetchOptions);
    } catch (_error) {
      req.removeListener('aborted', abortIfDisconnected);
      req.removeListener('close', abortIfDisconnected);
      logFailure(logger, method, pathname, 'UPSTREAM_UNAVAILABLE');
      return sendJson(res, 502, { error: 'Upstream unavailable', code: 'UPSTREAM_UNAVAILABLE' });
    }

    res.statusCode = upstream.status;
    for (const [name, value] of upstream.headers.entries()) {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
    }
    res.setHeader('cache-control', 'no-store');

    try {
      if (method === 'HEAD' || !upstream.body) {
        res.end();
      } else {
        await pipeline(Readable.fromWeb(upstream.body), res);
      }
      logRequest(logger, method, pathname, upstream.status, startedAt);
    } catch (_error) {
      if (!res.headersSent && !res.destroyed) {
        logFailure(logger, method, pathname, 'UPSTREAM_STREAM_FAILED');
        return sendJson(res, 502, { error: 'Upstream unavailable', code: 'UPSTREAM_UNAVAILABLE' });
      }
    } finally {
      req.removeListener('aborted', abortIfDisconnected);
      req.removeListener('close', abortIfDisconnected);
    }
  };
}

module.exports = {
  MAX_BODY_BYTES,
  createVercelRenderProxy
};
