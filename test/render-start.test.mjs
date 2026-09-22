import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnvironment } from '../scripts/render-start.mjs';

const valid = {
  CLICKUP_API_TOKEN: 'pk_fixture', CLICKUP_WORKSPACE_ID: '123',
  MCP_OAUTH_ISSUER: 'https://tenant.example/', MCP_OAUTH_ALLOWED_SUBJECT: 'provider|joshua',
  RENDER_EXTERNAL_URL: 'https://fixture.onrender.com', PORT: '12345',
};

test('Render defaults to read, binds PORT, and preserves exact issuer', () => {
  const env = renderEnvironment(valid);
  assert.equal(env.MCP_PROFILE, 'read');
  assert.equal(env.MCP_HTTP_PORT, '12345');
  assert.equal(env.MCP_HTTP_HOST, '0.0.0.0');
  assert.equal(env.MCP_OAUTH_ISSUER, 'https://tenant.example/');
  assert.equal(env.MCP_PUBLIC_URL, 'https://fixture.onrender.com/mcp');
  assert.equal(env.MCP_OAUTH_AUDIENCE, env.MCP_PUBLIC_URL);
});
test('Render refuses missing identity or authorization configuration', () => {
  for (const key of ['CLICKUP_API_TOKEN', 'CLICKUP_WORKSPACE_ID', 'MCP_OAUTH_ISSUER', 'MCP_OAUTH_ALLOWED_SUBJECT']) {
    assert.throws(() => renderEnvironment({ ...valid, [key]: ' ' }), new RegExp(key));
  }
});
test('Render refuses alternate credentials and outbound API overrides', () => {
  for (const key of ['MCP_AUTH_TOKEN', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'CLICKUP_API_BASE', 'MCP_OAUTH_JWKS_URL']) {
    assert.throws(() => renderEnvironment({ ...valid, [key]: 'unexpected' }), new RegExp(key));
  }
});
test('Render cannot enable URL tokens, dotenv or unconfined attachments', () => {
  const env = renderEnvironment({ ...valid, MCP_ALLOW_TOKEN_IN_PATH: '1', MCP_STRICT_ENV: '0', MCP_NO_ENV_FILE: '0', CLICKUP_ATTACH_ROOT: '/' });
  assert.equal(env.MCP_ALLOW_TOKEN_IN_PATH, '0');
  assert.equal(env.MCP_STRICT_ENV, '1');
  assert.equal(env.MCP_NO_ENV_FILE, '1');
  assert.equal(env.CLICKUP_ATTACH_ROOT, '/tmp/aiworkflo-clickup-attachments');
});
test('Render requires explicit core approval and disallows full/agent', () => {
  for (const profile of ['full', 'agent', 'core', 'typo']) {
    assert.throws(() => renderEnvironment({ ...valid, MCP_PROFILE: profile }));
  }
  assert.equal(renderEnvironment({ ...valid, MCP_PROFILE: 'core', MCP_SANDBOX_WRITE_APPROVED: '1' }).MCP_PROFILE, 'core');
});
test('Render rejects insecure or malformed URLs without echoing credentials', () => {
  for (const url of ['http://tenant.example', 'https://user:secret@tenant.example', 'https://tenant.example?token=secret', 'invalid']) {
    assert.throws(() => renderEnvironment({ ...valid, MCP_OAUTH_ISSUER: url }), (err) => !err.message.includes('secret'));
  }
  assert.throws(() => renderEnvironment({ ...valid, MCP_PUBLIC_URL: 'https://fixture.onrender.com/wrong' }));
  assert.throws(() => renderEnvironment({ ...valid, MCP_OAUTH_AUDIENCE: 'https://other.example' }));
});
test('Render validates TCP port', () => {
  for (const port of ['0', '65536', '-1', 'abc', '1.5']) assert.throws(() => renderEnvironment({ ...valid, PORT: port }));
});
