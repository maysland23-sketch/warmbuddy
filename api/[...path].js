const { createVercelRenderProxy } = require('../vercel-render-proxy');

module.exports = createVercelRenderProxy({
  renderOrigin: process.env.RENDER_ORIGIN,
  proxySecret: process.env.RENDER_PROXY_SECRET
});
