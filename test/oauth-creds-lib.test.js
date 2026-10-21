'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickOauthToken } = require('../src/main/oauth-creds-lib');

const NOW = 1_000_000_000_000;
const mcpOnly = JSON.stringify({ mcpOAuth: { x: { accessToken: 'mcp' } } });
const login = (token, expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });

test('skips a blob that only holds MCP tokens', () => {
  assert.strictEqual(pickOauthToken([mcpOnly, login('good', NOW + 3600e3)], NOW), 'good');
});

test('skips an expired login in favour of a fresh one', () => {
  assert.strictEqual(pickOauthToken([login('old', NOW - 1), login('new', NOW + 3600e3)], NOW), 'new');
});

test('treats a token within a minute of expiry as expired', () => {
  assert.strictEqual(pickOauthToken([login('edge', NOW + 30e3)], NOW), null);
});

test('accepts a token with no expiry', () => {
  assert.strictEqual(pickOauthToken([login('forever')], NOW), 'forever');
});

test('ignores missing and malformed blobs', () => {
  assert.strictEqual(pickOauthToken([null, undefined, 'not json', mcpOnly], NOW), null);
});
