import { createServer } from 'node:http';

// Setup only: deliberately no application imports, credential handling, or outbound calls.
export function discoveryConfig(env) {
  const httpsUrl = (raw, key) => {
    const value = raw?.trim();
    let url;
    try { url = new URL(value); } catch { throw new Error(`${key} must be an HTTPS URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error(`${key} must be HTTPS without credentials, query or fragment.`);
    }
    return { value, url };
  };
  const issuer = httpsUrl(env.MCP_OAUTH_ISSUER, 'MCP_OAUTH_ISSUER');
  const resource = httpsUrl(env.MCP_PUBLIC_URL, 'MCP_PUBLIC_URL');
  if (resource.url.pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL must end with /mcp.');
  if (env.MCP_PROFILE && env.MCP_PROFILE !== 'read') throw new Error('Discovery-only mode requires MCP_PROFILE=read.');
  const port = env.PORT || '10000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT must be 1–65535.');
  return {
    issuer: issuer.value, resource: resource.value, port: Number(port),
    metadataUrl: `${resource.url.origin}/.well-known/oauth-protected-resource/mcp`,
    commit: /^[a-f0-9]{40}$/.test(env.RENDER_GIT_COMMIT || '') ? env.RENDER_GIT_COMMIT : null,
  };
}

export function startDiscoveryOnly(env) {
  const config = discoveryConfig(env);
  const metadataPaths = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
  const metadata = JSON.stringify({
    resource: config.resource, authorization_servers: [config.issuer], bearer_methods_supported: ['header'],
  });
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'discovery-only', tools_enabled: false, profile: 'read', commit: config.commit }));
    } else if (req.method === 'GET' && metadataPaths.has(path)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(metadata);
    } else if (path.startsWith('/mcp')) {
      // Never inspect credentials. Even a valid token cannot enable MCP in this process.
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer realm="clickup-mcp", resource_metadata="${config.metadataUrl}"`,
      });
      res.end(JSON.stringify({ error: 'unauthorized', mode: 'discovery-only' }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('error', () => { console.error('[render-discovery] Listener failed.'); process.exitCode = 1; });
  server.listen(config.port, '0.0.0.0', () => console.log('[render-discovery] ready; all MCP access disabled'));
  const shutdown = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });
  return server;
}
