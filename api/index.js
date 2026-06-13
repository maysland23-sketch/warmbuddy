// Vercel serverless entry point — wraps the Express app for @vercel/node
const app = require('../server.js');

// Export as a plain function (more compatible with @vercel/node than exporting
// the Express app directly, especially with Express 5).
module.exports = (req, res) => {
  app(req, res);
};
