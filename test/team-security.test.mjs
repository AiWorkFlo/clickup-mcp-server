import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptCredential, decryptCredential, digest, teamConfig, safeRedirect, requireConfirmation } from '../build/team/security.js';

test('team configuration refuses missing secrets and ignores personal credentials', () => {
  assert.throws(() => teamConfig({ CLICKUP_API_TOKEN: 'pk_personal' }), /required/);
});
test('credentials are encrypted with authenticated encryption', () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptCredential('private-upstream-token', key, 'user-1');
  assert.ok(!encrypted.includes('private-upstream-token'));
  assert.equal(decryptCredential(encrypted, key, 'user-1'), 'private-upstream-token');
  assert.throws(() => decryptCredential(encrypted, key, 'user-2'));
  assert.throws(() => decryptCredential(encrypted, Buffer.alloc(32, 8), 'user-1'));
  assert.notEqual(encryptCredential('private-upstream-token', key, 'user-1'), encrypted);
  assert.notEqual(digest('one'), digest('two'));
});
test('client redirect matching rejects lookalike hosts and arbitrary redirects', () => {
  assert.ok(safeRedirect('https://chatgpt.com/connector_platform_oauth_redirect', ['https://chatgpt.com/connector_platform_oauth_redirect'], false));
  assert.ok(!safeRedirect('https://chatgpt.com.evil.test/connector_platform_oauth_redirect', ['https://chatgpt.com/connector_platform_oauth_redirect'], false));
  assert.ok(safeRedirect('http://127.0.0.1:51234/callback', ['http://127.0.0.1/callback'], true));
  assert.ok(!safeRedirect('http://127.0.0.1:51234/other', ['http://127.0.0.1/callback'], true));
  assert.ok(!safeRedirect('http://localhost.evil.test/callback', ['http://localhost/callback'], true));
});
test('team deletions require a separate explicit confirmation', () => {
  assert.throws(() => requireConfirmation({ delete: true }), /confirm/);
  assert.throws(() => requireConfirmation({ action: 'remove' }), /confirm/);
  assert.doesNotThrow(() => requireConfirmation({ delete: true, confirm: true }));
  assert.doesNotThrow(() => requireConfirmation({ action: 'create' }));
});
