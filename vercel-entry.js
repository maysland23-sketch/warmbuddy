// Vercel serverless entry point — wraps the Express app for @vercel/node
// Located at root level (not api/) so that ../server.js resolution is cleaner.
let app;
try {
  app = require('./server.js');
} catch (err) {
  console.error('[vercel-entry] Failed to load server.js:', err);
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

// Export a handler that properly manages Express 5's async lifecycle
module.exports = (req, res) => {
  try {
    // Express 5 app handles the request — any uncaught async errors are
    // caught by the global error handler middleware in server.js
    app(req, res);
  } catch (syncErr) {
    // Catch synchronous errors (e.g. from middleware setup, body parsing)
    console.error('[vercel-entry] Synchronous error:', syncErr.message);
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
