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

test('a new session asked for on a Codex CLI model runs the same GPT family in Claude Code', () => {
  const { chatgptIdForNewSession } = require('../src/main/provider-accounts-lib');
  assert.equal(chatgptIdForNewSession('codex:sol'), 'chatgpt:sol');
  assert.equal(chatgptIdForNewSession('codex:astra'), 'chatgpt:astra');
  assert.equal(chatgptIdForNewSession('codex:gpt-5.4-luna'), 'chatgpt:luna');
  assert.equal(chatgptIdForNewSession('codex:gpt-5.4-mini'), 'chatgpt:sol');
  for (const id of ['opus', 'chatgpt:terra', 'evren:glm-5.3', 'ollama:llama3', '', undefined]) {
    assert.equal(chatgptIdForNewSession(id), id);
  }
});

test('parseCodexUsage reads a weekly-only plan and a two-window plan', () => {
  const now = Date.UTC(2026, 10, 28, 12, 0, 0);
  const weekly = lib.parseCodexUsage({ rate_limit: { primary_window: { used_percent: 84, limit_window_seconds: 604800, reset_after_seconds: 533786, reset_at: now / 1000 + 86400 * 2 }, secondary_window: null } }, now);
  assert.deepEqual(weekly.windows.map((w) => [w.key, w.utilization, w.resetIn]), [['7d', 0.84, '2d']]);
  const both = lib.parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 150, limit_window_seconds: 604800, reset_after_seconds: 86400 * 3 },
  } }, now);
  assert.deepEqual(both.windows.map((w) => [w.key, w.utilization, w.resetIn]), [['5h', 0.1, '1h'], ['7d', 1, '3d']]);
  assert.equal(lib.parseCodexUsage({ rate_limit: null }, now), null);
  assert.equal(lib.parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 99 } } }, now), null);
});

test('deepseek model ids are their own frozen family', () => {
  assert.equal(modelFamily('deepseek:deepseek-v4-pro'), 'deepseek');
  assert.equal(lib.deepseekModelName('deepseek:deepseek-flash'), 'deepseek-flash');
  assert.equal(canSwitchModel('deepseek:deepseek-v4-pro', 'deepseek:deepseek-flash'), false);
  assert.equal(canSwitchModel('deepseek:deepseek-v4-pro', 'opus'), false);
});

test('cleanDeepseekKey only accepts sk- keys without whitespace', () => {
  assert.equal(lib.cleanDeepseekKey('  sk-0123456789abcdef '), 'sk-0123456789abcdef');
  assert.equal(lib.cleanDeepseekKey('evren_llm_abcdefgh12345'), '');
  assert.equal(lib.cleanDeepseekKey('sk-short'), '');
  assert.equal(lib.cleanDeepseekKey('sk-0123456789 abcdef'), '');
  assert.equal(lib.maskDeepseekKey('sk-0123456789abcdef'), 'sk-…cdef');
});

test('deepseekSpawnEnv routes through the /d proxy route and maps every Claude alias', () => {
  const env = lib.deepseekSpawnEnv({ port: 4000, model: 'deepseek:deepseek-v4-pro', subagentModel: 'default' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4000/d');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-pro');
  assert.equal(lib.deepseekSpawnEnv({ port: 1, model: 'deepseek:deepseek-v4-pro', subagentModel: 'deepseek:deepseek-flash' }).CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash');
});

test('the /d route is sent upstream below DeepSeek\'s /anthropic path with the key as bearer', () => {
  assert.deepEqual(lib.splitProviderPath('/d/v1/messages?beta=true'), { provider: 'deepseek', path: '/v1/messages?beta=true' });
  assert.equal(lib.upstreamPath('deepseek', '/v1/messages'), '/anthropic/v1/messages');
  assert.equal(lib.upstreamPath('evren', '/v1/messages'), '/v1/messages');
  const headers = lib.providerUpstreamHeaders({ 'x-api-key': 'session', host: '127.0.0.1' }, 'deepseek', { key: 'sk-abc' }, 0, HOP_BY_HOP_HEADERS);
  assert.equal(headers.host, 'api.deepseek.com');
  assert.equal(headers.authorization, 'Bearer sk-abc');
  assert.equal(headers['x-api-key'], undefined);
});

test('normalizeProviderStore keeps DeepSeek key entries separate from Evren ones', () => {
  const store = lib.normalizeProviderStore({ deepseek: { activeId: 'b', entries: [{ id: 'a', name: 'A', secret: 's1' }, { id: 'b', secret: 's2' }, { id: 'c' }] } });
  assert.deepEqual(store.deepseek.entries.map((e) => e.id), ['a', 'b']);
  assert.equal(store.deepseek.activeId, 'b');
  assert.deepEqual(store.evren.entries, []);
});

test('DeepSeek balance readings parse and format per currency', () => {
  const balance = lib.parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.58', granted_balance: '0.00', topped_up_balance: '1.58' }] });
  assert.deepEqual(balance, { available: true, balances: [{ currency: 'USD', total: 1.58, granted: 0, toppedUp: 1.58 }] });
  assert.equal(lib.formatDeepseekBalance(balance), '$1.58');
  assert.equal(lib.formatDeepseekBalance({ available: true, balances: [{ currency: 'CNY', total: 12, granted: 0, toppedUp: 12 }, { currency: 'EUR', total: 3, granted: 0, toppedUp: 3 }] }), '¥12.00 · 3.00 EUR');
  assert.equal(lib.parseDeepseekBalance({ error: 'x' }), null);
  assert.equal(lib.formatDeepseekBalance(null), '');
});

test('a GPT session pins its model on the command line; other sessions get no flag', () => {
  const { chatgptModelArgs } = require('../src/main/provider-accounts-lib');
  assert.deepEqual(chatgptModelArgs('chatgpt:sol'), ['--model', 'sol']);
  assert.deepEqual(chatgptModelArgs('chatgpt:astra'), ['--model', 'astra']);
  for (const id of ['opus', 'evren:glm-5.3', 'codex:sol', '', undefined]) assert.deepEqual(chatgptModelArgs(id), []);
});

test('a GPT session tells Claude Code its model\'s context window when one is known', () => {
  const { chatgptSpawnEnv } = require('../src/main/provider-accounts-lib');
  assert.equal(chatgptSpawnEnv({ port: 1, model: 'chatgpt:sol', contextTokens: 475000 }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, '475000');
  assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in chatgptSpawnEnv({ port: 1, model: 'chatgpt:sol' }), false);
});

test('a GPT session keeps its claude.ai login (so /voice works) and only falls back to the placeholder token without one', () => {
  const { chatgptSpawnEnv } = require('../src/main/provider-accounts-lib');
  const withLogin = chatgptSpawnEnv({ port: 7, model: 'chatgpt:sol', claudeLogin: true });
  assert.equal('ANTHROPIC_AUTH_TOKEN' in withLogin, false);
  assert.equal(withLogin.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7/g');
  assert.equal(chatgptSpawnEnv({ port: 7, model: 'chatgpt:sol' }).ANTHROPIC_AUTH_TOKEN, 'chatgpt-via-account-proxy');
});
