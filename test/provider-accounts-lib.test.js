const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/main/provider-accounts-lib');
const { modelFamily, canSwitchModel, codexSpawnArgs } = require('../src/main/agent-providers');
const { HOP_BY_HOP_HEADERS } = require('../src/main/account-proxy-lib');

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('evren model ids are their own frozen family', () => {
  assert.equal(modelFamily('evren:glm-5.3'), 'evren');
  assert.equal(lib.evrenModelName('evren:glm-5.3'), 'glm-5.3');
  assert.equal(canSwitchModel('evren:glm-5.3', 'evren:deepseek-v4.1-flash'), false);
  assert.equal(canSwitchModel('evren:glm-5.3', 'opus'), false);
});

test('cleanEvrenKey only accepts evren_llm_ keys without whitespace', () => {
  assert.equal(lib.cleanEvrenKey('  evren_llm_abcdefgh12345 '), 'evren_llm_abcdefgh12345');
  assert.equal(lib.cleanEvrenKey('sk-ant-abcdefghijklmnopqrstuvwxyz'), '');
  assert.equal(lib.cleanEvrenKey('evren_llm_ab cd'), '');
  assert.equal(lib.maskEvrenKey('evren_llm_abcdefgh1234'), 'evren_llm_…1234');
});

test('evrenSpawnEnv routes through the proxy and maps every Claude alias to Evren models', () => {
  const env = lib.evrenSpawnEnv({ port: 4000, model: 'evren:glm-5.3', subagentModel: 'default' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000/e');
  assert.equal(env.ANTHROPIC_MODEL, 'glm-5.3');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.3');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3.8-flash-next');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3');
  assert.equal(lib.evrenSpawnEnv({ port: 1, model: 'evren:glm-5.3', subagentModel: 'evren:deepseek-v4.1-flash' }).CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4.1-flash');
});

test('splitProviderPath strips the provider prefix', () => {
  assert.deepEqual(lib.splitProviderPath('/e/v1/messages?beta=true'), { provider: 'evren', path: '/v1/messages?beta=true' });
  assert.deepEqual(lib.splitProviderPath('/c/backend-api/codex/responses'), { provider: 'codex', path: '/backend-api/codex/responses' });
  assert.deepEqual(lib.splitProviderPath('/v1/messages'), { provider: '', path: '/v1/messages' });
  assert.deepEqual(lib.splitProviderPath('/evil/x'), { provider: '', path: '/evil/x' });
});

test('normalizeProviderStore keeps valid entries and falls back to a known active id', () => {
  const store = lib.normalizeProviderStore({
    evren: { activeId: 'gone', entries: [{ id: 'a', name: ' Main ', secret: 'plain:k' }, { id: 'a', name: 'dup', secret: 'x' }, { id: 'b' }] },
    codex: { activeId: 'c1', entries: [{ id: 'c1', name: 'Work', homeDir: '/h/work' }, { id: 'default', homeDir: '/x' }] },
  });
  assert.deepEqual(store.evren.entries, [{ id: 'a', name: 'Main', secret: 'plain:k' }]);
  assert.equal(store.evren.activeId, 'a');
  assert.equal(store.codex.activeId, 'c1');
  assert.equal(store.codex.entries.length, 1);
  assert.equal(lib.normalizeProviderStore(null).evren.activeId, '');
  assert.equal(lib.normalizeProviderStore(null).codex.activeId, 'default');
});

test('resolveActiveEntry falls back to the default Codex account when the chosen one is gone', () => {
  const store = lib.normalizeProviderStore({ codex: { entries: [{ id: 'c1', name: 'Work', homeDir: '/h' }] } });
  const fallback = { id: 'default', name: 'Default', homeDir: '/home/.codex' };
  assert.equal(lib.resolveActiveEntry(store, 'codex', 'c1', fallback).id, 'c1');
  assert.equal(lib.resolveActiveEntry(store, 'codex', 'removed', fallback), fallback);
  assert.equal(lib.resolveActiveEntry(store, 'evren', 'none'), null);
});

test('codexLoginFromAuth reads token, account id, expiry and email', () => {
  const now = Date.UTC(2026, 10, 25);
  const auth = { tokens: {
    access_token: jwt({ exp: now / 1000 + 3600 }), id_token: jwt({ email: 'me@x.com' }), account_id: 'acc-1', refresh_token: 'r',
  } };
  const login = lib.codexLoginFromAuth(auth, now);
  assert.equal(login.accountId, 'acc-1');
  assert.equal(login.email, 'me@x.com');
  assert.equal(login.expired, false);
  assert.equal(lib.codexLoginFromAuth(auth, now + 2 * 3600 * 1000).expired, true);
  assert.equal(lib.codexLoginFromAuth({}, now), null);
});

test('providerUpstreamHeaders swaps credentials per provider', () => {
  const incoming = { host: '127.0.0.1:1', authorization: 'Bearer own', 'x-api-key': 'k', connection: 'keep-alive', 'content-length': '3' };
  const evren = lib.providerUpstreamHeaders(incoming, 'evren', { key: 'evren_llm_z' }, 5, HOP_BY_HOP_HEADERS);
  assert.equal(evren.host, 'evren-llmapi.ssyz.org.tr');
  assert.equal(evren.authorization, 'Bearer evren_llm_z');
  assert.equal(evren['x-api-key'], undefined);
  assert.equal(evren.connection, undefined);
  assert.equal(evren['content-length'], '5');
  const codex = lib.providerUpstreamHeaders(incoming, 'codex', { accessToken: 't', accountId: 'a1' }, 0, HOP_BY_HOP_HEADERS);
  assert.equal(codex.host, 'chatgpt.com');
  assert.equal(codex.authorization, 'Bearer t');
  assert.equal(codex['chatgpt-account-id'], 'a1');
  // No credentials: the session's own stay.
  assert.equal(lib.providerUpstreamHeaders(incoming, 'codex', null, 0, HOP_BY_HOP_HEADERS).authorization, 'Bearer own');
});

test('codexSpawnArgs adds the proxy override only when a proxy port is given', () => {
  const base = { model: 'codex:sol', effort: 'medium', port: 1, ideId: 'i', platform: 'darwin' };
  assert.ok(!codexSpawnArgs(base).some((a) => String(a).includes('chatgpt_base_url')));
  assert.ok(codexSpawnArgs({ ...base, proxyPort: 4000 }).includes('chatgpt_base_url="http://127.0.0.1:4000/c/backend-api/"'));
});
