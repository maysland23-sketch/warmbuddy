const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { RENDER_PROXY_HEADER } = require('./render-api-security');

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-none-match', 'last-event-id']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'content-disposition', 'retry-after']);
const DUMMY_ORIGIN = 'http://vercel-proxy.invalid';
const INTERNAL_PATH_QUERY = '__warmbuddy_path';

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

function removeInternalPathQuery(search) {
  if (!search || search === '?') return '';
  const parts = search.slice(1).split('&');
  let removed = false;
  const remaining = parts.filter(part => {
    if (removed) return true;
    const separator = part.indexOf('=');
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    let key;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch (_error) {
      return true;
    }
    if (key !== INTERNAL_PATH_QUERY) return true;
    removed = true;
    return false;
  });
  return remaining.length > 0 ? `?${remaining.join('&')}` : '';
}

function resolveIncomingRequest(reqUrl) {
  const parsed = new URL(reqUrl || '/', DUMMY_ORIGIN);
  const rewrittenPath = parsed.searchParams.get(INTERNAL_PATH_QUERY);
  if (!rewrittenPath) {
    return { pathname: parsed.pathname, search: parsed.search };
  }

  const original = new URL(rewrittenPath, DUMMY_ORIGIN);
  if (original.origin !== DUMMY_ORIGIN || original.search || original.hash) {
    throw new Error('Invalid internal proxy path');
  }
  return {
    pathname: original.pathname,
    search: removeInternalPathQuery(parsed.search)
  };
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

function logRequest(logger, incomingPathname, resolvedTargetPathname, upstreamStatus) {
  if (!logger || typeof logger.info !== 'function') return;
  logger.info('[render-proxy]', {
    incomingPathname,
    resolvedTargetPathname,
    upstreamStatus
  });
}

function logFailure(logger, incomingPathname, resolvedTargetPathname) {
  if (!logger || typeof logger.error !== 'function') return;
  logger.error('[render-proxy]', {
    incomingPathname,
    resolvedTargetPathname,
    upstreamStatus: null
  });
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
    let incoming;
    try {
      incoming = resolveIncomingRequest(req.url);
    } catch (_error) {
      return sendJson(res, 400, { error: 'Invalid proxy path', code: 'INVALID_PROXY_PATH' });
    }
    const { pathname, search } = incoming;
    const target = origin ? new URL(pathname + search, origin) : null;
    const targetPathname = target ? target.pathname : null;

    if (!isApiPath(pathname)) {
      logRequest(logger, pathname, targetPathname, null);
      return sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    }
    if (!ALLOWED_METHODS.has(method)) {
      logRequest(logger, pathname, targetPathname, null);
      return sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    }
    if (configurationError) {
      logRequest(logger, pathname, targetPathname, null);
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
        logFailure(logger, pathname, targetPathname);
        return sendJson(res, 400, { error: 'Invalid request', code: 'REQUEST_READ_FAILED' });
      }
    }

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
      logFailure(logger, pathname, targetPathname);
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
      logRequest(logger, pathname, targetPathname, upstream.status);
    } catch (_error) {
      if (!res.headersSent && !res.destroyed) {
        logFailure(logger, pathname, targetPathname);
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
