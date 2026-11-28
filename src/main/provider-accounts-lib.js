'use strict';

// Pure, Electron-free logic behind the Evren API keys and the Codex accounts
// (see provider-accounts.js and .claude/memory/accounts.md). Unit-tested in
// test/provider-accounts-lib.test.js.
//
// Both providers work like the Claude accounts: a list of credentials with one
// "active" entry per app instance, switched without restarting sessions because
// the account proxy swaps the credentials on every request. The sessions
// themselves always run in the default config (`~/.claude` for Evren, `~/.codex`
// for Codex) — only the credentials differ between entries.

const { formatResetShort } = require('./usage-parse');

const PROVIDER_EVREN = 'evren';
const PROVIDER_CODEX = 'codex';
const PROVIDER_DEEPSEEK = 'deepseek';
const PROVIDERS = [PROVIDER_EVREN, PROVIDER_CODEX, PROVIDER_DEEPSEEK];
// Providers whose entries are plain API keys (stored encrypted), as opposed to Codex login folders.
const API_KEY_PROVIDERS = [PROVIDER_EVREN, PROVIDER_DEEPSEEK];
const DEFAULT_ENTRY_ID = 'default';

// SSB's Evren LLM platform speaks the Anthropic Messages protocol, so Claude Code
// runs against it unchanged (checked against the platform's Claude Code guide).
const EVREN_UPSTREAM_HOST = 'evren-llmapi.ssyz.org.tr';
const EVREN_KEY_PREFIX = 'evren_llm_';
const EVREN_MODEL_PREFIX = 'evren:';
// Codex with a ChatGPT login sends all its traffic to chatgpt.com/backend-api/.
const CODEX_UPSTREAM_HOST = 'chatgpt.com';

// DeepSeek's own API also speaks the Anthropic Messages protocol (under /anthropic),
// so Claude Code runs against it unchanged, billed to the user's DeepSeek balance.
const DEEPSEEK_UPSTREAM_HOST = 'api.deepseek.com';
const DEEPSEEK_ANTHROPIC_PATH = '/anthropic';
const DEEPSEEK_KEY_PREFIX = 'sk-';
const DEEPSEEK_MODEL_PREFIX = 'deepseek:';
const DEEPSEEK_MAIN_MODEL = 'deepseek-v4-pro';
const DEEPSEEK_FAST_MODEL = 'deepseek-flash';
const DEEPSEEK_SESSION_MODELS = [DEEPSEEK_MAIN_MODEL, DEEPSEEK_FAST_MODEL];

// Models offered for Evren sessions, and the one Claude Code's background work
// (titles, quick calls) uses instead of the main model.
const EVREN_MAIN_MODEL = 'glm-5.3';
const EVREN_FAST_MODEL = 'qwen3.8-flash-next';
const EVREN_SESSION_MODELS = [EVREN_MAIN_MODEL, 'deepseek-v4.1-flash'];

// Claude Code on a ChatGPT login: `chatgpt:<family>` models run the `claude` CLI
// against the account proxy's `/g` route, which translates Anthropic Messages to the
// Codex backend's Responses API (chatgpt-translate-lib.js) with the active Codex account.
const CHATGPT_MODEL_PREFIX = 'chatgpt:';
const CHATGPT_FAMILIES = ['sol', 'astra', 'terra', 'luna'];
const CHATGPT_FAST_FAMILY = 'luna';
const isChatgptId = (id) => typeof id === 'string' && id.startsWith(CHATGPT_MODEL_PREFIX);
const chatgptFamilyName = (id) => (isChatgptId(id) ? id.slice(CHATGPT_MODEL_PREFIX.length) : '');

// GPT is only offered through Claude Code: a new session asked for on a Codex CLI
// model (`codex:sol`, or a versioned `codex:gpt-5.4-sol`) gets the same family as a
// `chatgpt:` model instead. Any other id passes through unchanged.
function chatgptIdForNewSession(id) {
  if (typeof id !== 'string' || !id.startsWith('codex:')) return id;
  const family = CHATGPT_FAMILIES.find((f) => id.endsWith(f));
  return CHATGPT_MODEL_PREFIX + (family || 'sol');
}

const isEvrenId = (id) => typeof id === 'string' && id.startsWith(EVREN_MODEL_PREFIX);
const evrenModelName = (id) => (isEvrenId(id) ? id.slice(EVREN_MODEL_PREFIX.length) : String(id || ''));

// The route prefixes the account proxy serves provider traffic under.
const ROUTE_CHATGPT = 'chatgpt';
const ROUTE_PREFIX = { [PROVIDER_EVREN]: '/e', [PROVIDER_CODEX]: '/c', [PROVIDER_DEEPSEEK]: '/d', [ROUTE_CHATGPT]: '/g' };
const UPSTREAM_HOST = { [PROVIDER_EVREN]: EVREN_UPSTREAM_HOST, [PROVIDER_CODEX]: CODEX_UPSTREAM_HOST, [PROVIDER_DEEPSEEK]: DEEPSEEK_UPSTREAM_HOST };
// DeepSeek serves its Anthropic-compatible API below a sub-path, unlike the other providers.
const UPSTREAM_PATH_PREFIX = { [PROVIDER_DEEPSEEK]: DEEPSEEK_ANTHROPIC_PATH };

const isDeepseekId = (id) => typeof id === 'string' && id.startsWith(DEEPSEEK_MODEL_PREFIX);
const deepseekModelName = (id) => (isDeepseekId(id) ? id.slice(DEEPSEEK_MODEL_PREFIX.length) : String(id || ''));

// The path to request upstream for a path seen on the provider's proxy route.
const upstreamPath = (provider, path) => `${UPSTREAM_PATH_PREFIX[provider] || ''}${path}`;

function emptyProviderState() {
  return { activeId: DEFAULT_ENTRY_ID, entries: [] };
}

// Whatever was on disk → { evren: { activeId, entries }, codex: { activeId, entries } }.
// An Evren entry is { id, name, secret } (secret = the stored form of the key, see
// encodeStoredApiKey). A Codex entry is { id, name, homeDir } (a CODEX_HOME holding
// that account's login); the built-in default Codex account is implied, not stored.
function normalizeProviderStore(raw) {
  const store = {};
  for (const provider of PROVIDERS) store[provider] = emptyProviderState();
  for (const provider of PROVIDERS) {
    const source = raw && raw[provider];
    const seen = new Set([DEFAULT_ENTRY_ID]);
    for (const e of (source && Array.isArray(source.entries) ? source.entries : [])) {
      if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
      const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.id;
      if (API_KEY_PROVIDERS.includes(provider) && typeof e.secret === 'string' && e.secret) {
        store[provider].entries.push({ id: e.id, name, secret: e.secret });
      } else if (provider === PROVIDER_CODEX && typeof e.homeDir === 'string' && e.homeDir) {
        store[provider].entries.push({ id: e.id, name, homeDir: e.homeDir });
      } else continue;
      seen.add(e.id);
    }
    const isKnownId = source && (source.activeId === DEFAULT_ENTRY_ID || store[provider].entries.some((e) => e.id === source.activeId));
    // The key providers have no built-in entry: without any key, nothing is active.
    store[provider].activeId = isKnownId ? source.activeId : defaultActiveId(provider, store[provider].entries);
    if (provider === PROVIDER_CODEX && source && typeof source.defaultName === 'string' && source.defaultName.trim()) {
      store[provider].defaultName = source.defaultName.trim();
    }
  }
  return store;
}

// Codex always has its built-in default account; the key providers start on their first key.
function defaultActiveId(provider, entries) {
  if (provider === PROVIDER_CODEX) return DEFAULT_ENTRY_ID;
  return entries.length ? entries[0].id : '';
}

// The entry an app instance runs as: the one it chose, or the fallback when that one
// is gone (another instance removed it). null when there is none (Evren, no keys).
function resolveActiveEntry(store, provider, activeId, defaultEntry = null) {
  const entries = store[provider].entries;
  if (provider === PROVIDER_CODEX && (activeId === DEFAULT_ENTRY_ID || !entries.some((e) => e.id === activeId))) return defaultEntry;
  return entries.find((e) => e.id === activeId) || entries[0] || null;
}

// A pasted DeepSeek key, trimmed; '' when it can't be one.
function cleanDeepseekKey(raw) {
  const key = String(raw || '').trim();
  return key.startsWith(DEEPSEEK_KEY_PREFIX) && key.length >= 16 && !/\s/.test(key) ? key : '';
}

// "sk-…abcd": the prefix and the last four characters only.
function maskDeepseekKey(key) {
  return key ? `${DEEPSEEK_KEY_PREFIX}…${key.slice(-4)}` : '';
}

// A DeepSeek balance reading ({ is_available, balance_infos: [...] } from GET /user/balance)
// → { available, balances: [{ currency, total, granted, toppedUp }] } with numbers; null when unreadable.
function parseDeepseekBalance(body) {
  if (!body || !Array.isArray(body.balance_infos)) return null;
  return {
    available: body.is_available !== false,
    balances: body.balance_infos.map((b) => ({
      currency: String(b.currency || ''),
      total: Number(b.total_balance) || 0,
      granted: Number(b.granted_balance) || 0,
      toppedUp: Number(b.topped_up_balance) || 0,
    })),
  };
}

// "$1.58" / "¥12.00" / "1.58 EUR": the balance line shown under a DeepSeek key.
function formatDeepseekBalance(balance) {
  if (!balance || !balance.balances.length) return '';
  const symbols = { USD: '$', CNY: '¥' };
  return balance.balances.map((b) => (symbols[b.currency] ? `${symbols[b.currency]}${b.total.toFixed(2)}` : `${b.total.toFixed(2)} ${b.currency}`)).join(' · ');
}

// The env that makes a `claude` session run on DeepSeek through the account proxy
// (same placeholder-token scheme as Evren). Every Claude alias maps onto a DeepSeek
// model; unmapped ones would be sent to DeepSeek under Claude names.
function deepseekSpawnEnv({ port, model, subagentModel }) {
  const main = deepseekModelName(model) || DEEPSEEK_MAIN_MODEL;
  const subagent = isDeepseekId(subagentModel) ? deepseekModelName(subagentModel) : main;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX[PROVIDER_DEEPSEEK]}`,
    ANTHROPIC_AUTH_TOKEN: 'deepseek-via-account-proxy',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_FAST_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: subagent,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// A pasted Evren key, trimmed; '' when it can't be one.
function cleanEvrenKey(raw) {
  const key = String(raw || '').trim();
  return key.startsWith(EVREN_KEY_PREFIX) && key.length >= EVREN_KEY_PREFIX.length + 8 && !/\s/.test(key) ? key : '';
}

// "evren_llm_…abcd": the prefix and the last four characters only.
function maskEvrenKey(key) {
  return key ? `${EVREN_KEY_PREFIX}…${key.slice(-4)}` : '';
}

// The env that makes a `claude` session talk to Evren through the account proxy.
// The CLI insists on *a* credential, so it gets a placeholder token that the proxy
// replaces with the active Evren key on every request. The model names map every
// Claude alias onto Evren models: unmapped ones would be sent to Evren as Claude
// names, which it does not know.
function evrenSpawnEnv({ port, model, subagentModel }) {
  const main = evrenModelName(model) || EVREN_MAIN_MODEL;
  const subagent = isEvrenId(subagentModel) ? evrenModelName(subagentModel) : main;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX[PROVIDER_EVREN]}`,
    ANTHROPIC_AUTH_TOKEN: 'evren-via-account-proxy',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: EVREN_FAST_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: subagent,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

// The env that makes a `claude` session run a ChatGPT model through the proxy. The
// model names are the family aliases (`sol`, `luna`…): the proxy resolves them to the
// current GPT model, so no Claude name ever reaches ChatGPT.
// `contextTokens` is the GPT model's window: Claude Code doesn't know the alias, so
// without it it warns at startup and assumes 200k.
// `claudeLogin`: the session's Claude account is a claude.ai login. The placeholder
// token is then left out so the CLI keeps that login — Claude Code only offers
// /voice to a claude.ai login, and any ANTHROPIC_AUTH_TOKEN turns that check off.
// The proxy's GPT route ignores the login it is sent (it always answers with the
// active Codex login), so nothing Claude-side reaches ChatGPT. An API-key account
// has no login to keep and still needs the placeholder.
function chatgptSpawnEnv({ port, model, subagentModel, contextTokens, claudeLogin = false }) {
  const main = chatgptFamilyName(model) || 'sol';
  const subagent = isChatgptId(subagentModel) ? chatgptFamilyName(subagentModel) : main;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX[ROUTE_CHATGPT]}`,
    ...(claudeLogin ? {} : { ANTHROPIC_AUTH_TOKEN: 'chatgpt-via-account-proxy' }),
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CHATGPT_FAST_FAMILY,
    CLAUDE_CODE_SUBAGENT_MODEL: subagent,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(contextTokens > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens) } : {}),
  };
}

// The launch flag that pins a GPT session's model. `--model` outranks ANTHROPIC_MODEL
// and a `model` in the user's Claude settings, so the session can't start on Claude.
function chatgptModelArgs(model) {
  return isChatgptId(model) ? ['--model', chatgptFamilyName(model)] : [];
}

// The Codex `-c` override that sends its ChatGPT traffic through the account proxy.
function codexProxyOverride(port) {
  return ['-c', `chatgpt_base_url="http://127.0.0.1:${port}${ROUTE_PREFIX[PROVIDER_CODEX]}/backend-api/"`];
}

// A request path → { provider, path }: which provider route it belongs to ('' for
// none) and the path to send upstream.
function splitProviderPath(url) {
  const raw = String(url || '/');
  for (const provider of Object.keys(ROUTE_PREFIX)) {
    const prefix = ROUTE_PREFIX[provider];
    if (raw === prefix || raw.startsWith(`${prefix}/`) || raw.startsWith(`${prefix}?`)) {
      const rest = raw.slice(prefix.length);
      return { provider, path: rest.startsWith('/') ? rest : `/${rest}` };
    }
  }
  return { provider: '', path: raw };
}

// Codex reports each rate-limit window with its length in seconds; the Claude meter
// names its windows by length too, so a 5-hour window reads '5h' and a week '7d'.
const CODEX_WINDOW_KEYS = [{ seconds: 5 * 3600, key: '5h' }, { seconds: 7 * 86400, key: '7d' }];

function codexWindowKey(seconds) {
  if (!Number.isFinite(seconds)) return '';
  // Nearest known length, so a plan whose "weekly" window is a day off still reads as weekly.
  const nearest = CODEX_WINDOW_KEYS.reduce((best, w) => (Math.abs(w.seconds - seconds) < Math.abs(best.seconds - seconds) ? w : best));
  return Math.abs(nearest.seconds - seconds) <= nearest.seconds * 0.5 ? nearest.key : '';
}

// The body of GET chatgpt.com/backend-api/wham/usage → the usage-meter view model
// ({ windows: [{ key, utilization 0..1, resetAt ms, resetIn }] }) the Claude rows
// use. Plans may have one window (weekly only) or two; null when there is none.
function parseCodexUsage(body, nowMs = Date.now()) {
  const limit = body && body.rate_limit;
  if (!limit) return null;
  const windows = [];
  for (const raw of [limit.primary_window, limit.secondary_window]) {
    if (!raw || typeof raw.used_percent !== 'number') continue;
    const key = codexWindowKey(raw.limit_window_seconds);
    if (!key || windows.some((w) => w.key === key)) continue;
    const resetAt = typeof raw.reset_at === 'number' ? raw.reset_at * 1000
      : typeof raw.reset_after_seconds === 'number' ? nowMs + raw.reset_after_seconds * 1000 : null;
    windows.push({
      key,
      utilization: Math.max(0, Math.min(1, raw.used_percent / 100)),
      resetAt,
      resetIn: formatResetShort(resetAt, nowMs),
    });
  }
  return windows.length ? { windows } : null;
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

// What the proxy and the menu need from a Codex `auth.json` (ChatGPT login):
// the access token and account id the backend wants as headers, when the token
// runs out, and the email shown in the menu. null when there is no usable login.
function codexLoginFromAuth(auth, now = Date.now()) {
  const tokens = auth && auth.tokens;
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) return null;
  const access = decodeJwtPayload(tokens.access_token);
  const identity = decodeJwtPayload(tokens.id_token);
  const expiresAt = access && typeof access.exp === 'number' ? access.exp * 1000 : 0;
  const accountId = tokens.account_id || (identity && identity['https://api.openai.com/auth']?.chatgpt_account_id) || '';
  return {
    accessToken: tokens.access_token,
    accountId,
    expiresAt,
    expired: !!expiresAt && now >= expiresAt - 60 * 1000,
    hasRefreshToken: typeof tokens.refresh_token === 'string' && !!tokens.refresh_token,
    email: (identity && identity.email) || '',
  };
}

// The credential headers a provider route sends in place of the session's own.
// Evren: the key as a bearer token. Codex: the account's bearer plus its account id.
function credentialHeaders(provider, credentials) {
  if (!credentials) return {};
  if (API_KEY_PROVIDERS.includes(provider)) return { authorization: `Bearer ${credentials.key}` };
  const headers = { authorization: `Bearer ${credentials.accessToken}` };
  if (credentials.accountId) headers['chatgpt-account-id'] = credentials.accountId;
  return headers;
}

// The headers to send upstream on a provider route: the incoming ones minus
// hop-by-hop headers, the provider's host, the buffered body's length, and the
// active entry's credentials in place of the session's own.
function providerUpstreamHeaders(incoming, provider, credentials, bodyLength, hopByHopHeaders) {
  const headers = { ...incoming };
  for (const name of hopByHopHeaders) delete headers[name];
  headers.host = UPSTREAM_HOST[provider];
  if (bodyLength > 0 || headers['content-length'] !== undefined) headers['content-length'] = String(bodyLength);
  if (API_KEY_PROVIDERS.includes(provider) && credentials) delete headers['x-api-key'];
  return { ...headers, ...credentialHeaders(provider, credentials) };
}

module.exports = {
  PROVIDER_EVREN, PROVIDER_CODEX, PROVIDER_DEEPSEEK, PROVIDERS, API_KEY_PROVIDERS,
  DEEPSEEK_UPSTREAM_HOST, DEEPSEEK_KEY_PREFIX, DEEPSEEK_MODEL_PREFIX, DEEPSEEK_MAIN_MODEL, DEEPSEEK_FAST_MODEL, DEEPSEEK_SESSION_MODELS,
  isDeepseekId, deepseekModelName, upstreamPath, cleanDeepseekKey, maskDeepseekKey, parseDeepseekBalance, formatDeepseekBalance, deepseekSpawnEnv, DEFAULT_ENTRY_ID,
  EVREN_UPSTREAM_HOST, EVREN_KEY_PREFIX, EVREN_MODEL_PREFIX, CODEX_UPSTREAM_HOST,
  EVREN_MAIN_MODEL, EVREN_FAST_MODEL, EVREN_SESSION_MODELS,
  CHATGPT_MODEL_PREFIX, CHATGPT_FAMILIES, ROUTE_CHATGPT, isChatgptId, chatgptFamilyName, chatgptSpawnEnv, chatgptIdForNewSession, chatgptModelArgs,
  isEvrenId, evrenModelName, normalizeProviderStore, resolveActiveEntry,
  cleanEvrenKey, maskEvrenKey, evrenSpawnEnv, codexProxyOverride, splitProviderPath,
  codexLoginFromAuth, parseCodexUsage, credentialHeaders, providerUpstreamHeaders, UPSTREAM_HOST,
};
