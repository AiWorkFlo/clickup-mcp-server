if (process.env.MCP_MODE === 'team') {
  await import('../build/team/index.js');
} else if (process.env.MCP_MODE === 'discovery-only' || process.env.MCP_DISCOVERY_ONLY === '1') {
  const { startDiscoveryOnly } = await import('./render-discovery.mjs');
  startDiscoveryOnly(process.env);
} else {
  console.error('[coolify] Set MCP_MODE=team or explicitly use discovery-only mode.');
  process.exitCode = 1;
}
