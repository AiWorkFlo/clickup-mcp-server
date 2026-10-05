import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { discoveryConfig } from '../scripts/render-discovery.mjs';
import { renderEnvironment } from '../scripts/render-start.mjs';
import { buildEnvironment } from '../scripts/render-build.mjs';

const config = {
  MCP_DISCOVERY_ONLY: '1', MCP_PROFILE: 'read',
  MCP_PUBLIC_URL: 'https://fixture.onrender.com/mcp', MCP_OAUTH_ISSUER: 'https://tenant.example/',
};

test('discovery configuration needs only public values and rejects unsafe settings', () => {
  assert.equal(discoveryConfig(config).issuer, 'https://tenant.example/');
  assert.equal(discoveryConfig(config).resource, config.MCP_PUBLIC_URL);
  for (const key of ['MCP_PUBLIC_URL', 'MCP_OAUTH_ISSUER']) {
    for (const value of ['', 'http://tenant.example', 'https://user:secret@tenant.example', 'https://tenant.example?secret=1', 'https://tenant.example/#secret']) {
      assert.throws(() => discoveryConfig({ ...config, [key]: value }), (error) => !error.message.includes('secret'));
    }
  }
  assert.throws(() => discoveryConfig({ ...config, MCP_PUBLIC_URL: 'https://fixture.onrender.com/other' }));
  assert.throws(() => discoveryConfig({ ...config, MCP_PROFILE: 'core' }));
  for (const port of ['0', '65536', 'NaN', '1.5']) assert.throws(() => discoveryConfig({ ...config, PORT: port }));
  assert.throws(() => renderEnvironment(config), /CLICKUP_API_TOKEN/);
  assert.throws(() => renderEnvironment({ ...config, CLICKUP_API_TOKEN: 'pk_fixture', CLICKUP_WORKSPACE_ID: '123' }), /MCP_OAUTH_ALLOWED_SUBJECT/);
});

for (const credentials of [{}, { CLICKUP_API_TOKEN: 'pk_fixture', CLICKUP_WORKSPACE_ID: '123', MCP_OAUTH_ALLOWED_SUBJECT: 'fixture-user', MCP_AUTH_TOKEN: 'fixture-secret' }]) {
test(`actual launcher remains discovery-only with ${Object.keys(credentials).length ? 'stored' : 'no'} credentials`, async () => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), 'discovery-test-'));
  const guard = join(dir, 'guard.mjs');
  await writeFile(guard, `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
const deny = () => { throw new Error('Unexpected outbound call'); };
net.Socket.prototype.connect = deny;
http.request = http.get = https.request = https.get = globalThis.fetch = deny;
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  const forbidden = ${JSON.stringify(['build/', 'src/', 'node_modules/'].map((path) => new URL('../' + path, import.meta.url).href))};
  if (forbidden.some((prefix) => result.url.startsWith(prefix))) throw new Error('Unexpected application import');
  return result;
} });
`);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const payload = [
    { alg: 'RS256', typ: 'JWT' },
    { iss: config.MCP_OAUTH_ISSUER, aud: config.MCP_PUBLIC_URL, sub: 'fixture-user', exp: Math.floor(Date.now() / 1000) + 300 },
  ].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const jwt = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
  const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, 'scripts/render-start.mjs'], {
    env: { ...buildEnvironment(process.env), ...config, ...credentials, RENDER_GIT_COMMIT: '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let logs = '';
  child.stderr.on('data', (data) => { logs += data; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Discovery readiness timeout')), 10000);
      child.once('error', reject);
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Discovery exited before readiness')); });
      child.stdout.on('data', (data) => {
        logs += data;
        if (logs.includes('ready;')) { clearTimeout(timer); resolve(); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(health, { ok: true, mode: 'discovery-only', tools_enabled: false, profile: 'read', commit: null });
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(base + path, { headers: { 'X-Forwarded-Host': 'attacker.example' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { resource: config.MCP_PUBLIC_URL, authorization_servers: [config.MCP_OAUTH_ISSUER], bearer_methods_supported: ['header'] });
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 404);
    }
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      for (const authorization of ['', 'Bearer fixture-secret', `Bearer ${jwt}`]) {
        const res = await fetch(`${base}/mcp`, {
          method, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) } : {}),
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="clickup-mcp", resource_metadata="https://fixture.onrender.com/.well-known/oauth-protected-resource/mcp"');
        assert.deepEqual(await res.json(), { error: 'unauthorized', mode: 'discovery-only' });
      }
    }
    assert.equal((await fetch(`${base}/mcp/fixture-secret`)).status, 401);
    for (const path of ['/', '/healthz', '/tools', '/.well-known/openid-configuration']) assert.equal((await fetch(base + path)).status, 404);
    assert.doesNotMatch(logs, /Unexpected|fixture-secret|fixture-user/);
  } finally {
    child.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
}
