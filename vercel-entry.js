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

module.exports = (req, res) => {
  app(req, res);
};
