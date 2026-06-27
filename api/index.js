// Vercel serverless entry point — wraps the Express app for @vercel/node
let app;
try {
  app = require('../server.js');
} catch (err) {
  // If server.js fails to load, export a fallback that reports the error
  console.error('[api/index] Failed to load server.js:', err);
  module.exports = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Server module failed to load',
      detail: err.message,
      code: err.code || 'UNKNOWN'
    }));
  };
  return;
}

// Export a handler that properly manages Express 5's async lifecycle.
// Express 5 internally handles async route handlers, but we need to catch
// synchronous startup errors and ensure proper error propagation.
module.exports = (req, res) => {
  try {
    // Express 5 app handles the request — any uncaught async errors are
    // caught by the global error handler middleware in server.js
    app(req, res);
  } catch (syncErr) {
    // Catch synchronous errors (e.g. from middleware setup, body parsing)
    console.error('[api/index] Synchronous error:', syncErr.message);
    if (!res.headersSent) {
      res.statusCode = res.statusCode || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: 'Internal server error',
        detail: syncErr.message,
        code: syncErr.code || 'INTERNAL_ERROR'
      }));
    }
  }
};
