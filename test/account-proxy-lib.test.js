'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/main/account-proxy-lib');

test('canRouteThroughProxy: only a plain claude.ai setup goes through the proxy', () => {
  assert.equal(lib.canRouteThroughProxy({ PATH: '/bin' }, {}), true);
  assert.equal(lib.canRouteThroughProxy({ ANTHROPIC_BASE_URL: 'https://gw' }, {}), false);
  assert.equal(lib.canRouteThroughProxy({ ANTHROPIC_API_KEY: 'sk' }, {}), false);
  assert.equal(lib.canRouteThroughProxy({}, { CLAUDE_CODE_USE_BEDROCK: '1' }), false);
  // Settings env is applied by the CLI over ours, so a base URL there bypasses us.
  assert.equal(lib.canRouteThroughProxy({}, { ANTHROPIC_BASE_URL: 'https://gw' }), false);
  assert.equal(lib.canRouteThroughProxy(undefined, undefined), true);
});

test('proxyRouteEnv: points the CLI at the loopback port', () => {
  assert.deepEqual(lib.proxyRouteEnv(4123), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123' });
});

test('carriesClaudeLogin: only an OAuth bearer without an API key is swapped', () => {
  assert.equal(lib.carriesClaudeLogin({ authorization: 'Bearer abc' }), true);
  assert.equal(lib.carriesClaudeLogin({ authorization: 'bearer abc' }), true);
  assert.equal(lib.carriesClaudeLogin({}), false);
  assert.equal(lib.carriesClaudeLogin({ authorization: 'Bearer ' }), false);
  assert.equal(lib.carriesClaudeLogin({ authorization: 'Bearer abc', 'x-api-key': 'sk' }), false);
  assert.equal(lib.carriesClaudeLogin(null), false);
});

test('upstreamHeaders: swaps the login, retargets the host, drops hop-by-hop headers', () => {
  const incoming = {
    host: '127.0.0.1:4123', authorization: 'Bearer own', connection: 'keep-alive',
    'transfer-encoding': 'chunked', 'anthropic-beta': 'oauth-2025-04-20', 'content-length': '9',
  };
  const out = lib.upstreamHeaders(incoming, 'other', 12);
  assert.equal(out.host, 'api.anthropic.com');
  assert.equal(out.authorization, 'Bearer other');
  assert.equal(out['content-length'], '12');
  assert.equal(out['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(out.connection, undefined);
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(incoming.authorization, 'Bearer own', 'the incoming headers are not mutated');
});

test('upstreamHeaders: no token keeps the session\'s own login; a bodiless HEAD gets no length', () => {
  assert.equal(lib.upstreamHeaders({ authorization: 'Bearer own' }, null, 5).authorization, 'Bearer own');
  assert.equal(lib.upstreamHeaders({}, null, 0)['content-length'], undefined);
});

test('isCachedLoginFresh: re-read after a minute or near expiry', () => {
  const now = 10_000_000;
  const entry = { token: 't', expiresAt: now + 3_600_000, readAt: now - 1000 };
  assert.equal(lib.isCachedLoginFresh(entry, now), true);
  assert.equal(lib.isCachedLoginFresh({ ...entry, readAt: now - lib.LOGIN_REREAD_MS }, now), false);
  assert.equal(lib.isCachedLoginFresh({ ...entry, expiresAt: now + 1000 }, now), false);
  assert.equal(lib.isCachedLoginFresh({ ...entry, expiresAt: 0 }, now), true);
  assert.equal(lib.isCachedLoginFresh(null, now), false);
  assert.equal(lib.isCachedLoginFresh({ ...entry, token: '' }, now), false);
});

test('loginAction: use a live login, renew a lapsed one with a refresh token, else none', () => {
  assert.equal(lib.loginAction({ accessToken: 'a', expired: false }), 'use');
  assert.equal(lib.loginAction({ accessToken: 'a', expired: true, hasRefreshToken: true }), 'renew');
  assert.equal(lib.loginAction({ accessToken: 'a', expired: true, hasRefreshToken: false }), 'none');
  assert.equal(lib.loginAction(null), 'none');
});

test('isLoginRefused: only a 401 triggers a renew-and-retry', () => {
  assert.equal(lib.isLoginRefused(401), true);
  for (const status of [200, 403, 429, 500, 529]) assert.equal(lib.isLoginRefused(status), false);
});

test('proxyRouteEnv / splitMeteredPath: API-key sessions carry their account in the path', () => {
  assert.deepEqual(lib.proxyRouteEnv(5000), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000' });
  const env = lib.proxyRouteEnv(5000, 'dir-my key');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5000/k/dir-my%20key');
  assert.deepEqual(lib.splitMeteredPath('/k/dir-my%20key/v1/messages?beta=true'),
    { accountId: 'dir-my key', path: '/v1/messages?beta=true' });
  assert.deepEqual(lib.splitMeteredPath('/v1/messages'), { accountId: '', path: '/v1/messages' });
  assert.deepEqual(lib.splitMeteredPath('/k/abc'), { accountId: 'abc', path: '/' });
  assert.deepEqual(lib.splitMeteredPath('/k/%E0%A4%A/v1'), { accountId: '', path: '/v1' });
});

test('isBilledMessagesRequest: message creation only, not token counting', () => {
  assert.equal(lib.isBilledMessagesRequest('POST', '/v1/messages'), true);
  assert.equal(lib.isBilledMessagesRequest('POST', '/v1/messages?beta=true'), true);
  assert.equal(lib.isBilledMessagesRequest('POST', '/v1/messages/count_tokens'), false);
  assert.equal(lib.isBilledMessagesRequest('HEAD', '/v1/messages'), false);
});

test('canMeterThroughProxy: the session\'s own key is fine, another route is not', () => {
  assert.equal(lib.canMeterThroughProxy({ ANTHROPIC_API_KEY: 'sk' }, {}), true);
  assert.equal(lib.canMeterThroughProxy({ ANTHROPIC_API_KEY: 'sk', ANTHROPIC_BASE_URL: 'http://x' }, {}), false);
  assert.equal(lib.canMeterThroughProxy({ ANTHROPIC_API_KEY: 'sk' }, { CLAUDE_CODE_USE_BEDROCK: '1' }), false);
});
