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

const PROVIDER_EVREN = 'evren';
const PROVIDER_CODEX = 'codex';
const PROVIDERS = [PROVIDER_EVREN, PROVIDER_CODEX];
const DEFAULT_ENTRY_ID = 'default';

// SSB's Evren LLM platform speaks the Anthropic Messages protocol, so Claude Code
// runs against it unchanged (checked against the platform's Claude Code guide).
const EVREN_UPSTREAM_HOST = 'evren-llmapi.ssyz.org.tr';
const EVREN_KEY_PREFIX = 'evren_llm_';
const EVREN_MODEL_PREFIX = 'evren:';
// Codex with a ChatGPT login sends all its traffic to chatgpt.com/backend-api/.
const CODEX_UPSTREAM_HOST = 'chatgpt.com';

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
const ROUTE_PREFIX = { [PROVIDER_EVREN]: '/e', [PROVIDER_CODEX]: '/c', [ROUTE_CHATGPT]: '/g' };
const UPSTREAM_HOST = { [PROVIDER_EVREN]: EVREN_UPSTREAM_HOST, [PROVIDER_CODEX]: CODEX_UPSTREAM_HOST };

function emptyProviderState() {
  return { activeId: DEFAULT_ENTRY_ID, entries: [] };
}

// Whatever was on disk → { evren: { activeId, entries }, codex: { activeId, entries } }.
// An Evren entry is { id, name, secret } (secret = the stored form of the key, see
// encodeStoredApiKey). A Codex entry is { id, name, homeDir } (a CODEX_HOME holding
// that account's login); the built-in default Codex account is implied, not stored.
function normalizeProviderStore(raw) {
  const store = { [PROVIDER_EVREN]: emptyProviderState(), [PROVIDER_CODEX]: emptyProviderState() };
  for (const provider of PROVIDERS) {
    const source = raw && raw[provider];
    const seen = new Set([DEFAULT_ENTRY_ID]);
    for (const e of (source && Array.isArray(source.entries) ? source.entries : [])) {
      if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
      const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.id;
      if (provider === PROVIDER_EVREN && typeof e.secret === 'string' && e.secret) {
        store[provider].entries.push({ id: e.id, name, secret: e.secret });
      } else if (provider === PROVIDER_CODEX && typeof e.homeDir === 'string' && e.homeDir) {
        store[provider].entries.push({ id: e.id, name, homeDir: e.homeDir });
      } else continue;
      seen.add(e.id);
    }
    const isKnownId = source && (source.activeId === DEFAULT_ENTRY_ID || store[provider].entries.some((e) => e.id === source.activeId));
    // Evren has no built-in entry: without any key, nothing is active.
    store[provider].activeId = isKnownId ? source.activeId : defaultActiveId(provider, store[provider].entries);
    if (provider === PROVIDER_CODEX && source && typeof source.defaultName === 'string' && source.defaultName.trim()) {
      store[provider].defaultName = source.defaultName.trim();
    }
  }
  return store;
}

// Codex always has its built-in default account; Evren starts on its first key.
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
function chatgptSpawnEnv({ port, model, subagentModel }) {
  const main = chatgptFamilyName(model) || 'sol';
  const subagent = isChatgptId(subagentModel) ? chatgptFamilyName(subagentModel) : main;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}${ROUTE_PREFIX[ROUTE_CHATGPT]}`,
    ANTHROPIC_AUTH_TOKEN: 'chatgpt-via-account-proxy',
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CHATGPT_FAST_FAMILY,
    CLAUDE_CODE_SUBAGENT_MODEL: subagent,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
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
  if (provider === PROVIDER_EVREN) return { authorization: `Bearer ${credentials.key}` };
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
  if (provider === PROVIDER_EVREN && credentials) delete headers['x-api-key'];
  return { ...headers, ...credentialHeaders(provider, credentials) };
}

module.exports = {
  PROVIDER_EVREN, PROVIDER_CODEX, PROVIDERS, DEFAULT_ENTRY_ID,
  EVREN_UPSTREAM_HOST, EVREN_KEY_PREFIX, EVREN_MODEL_PREFIX, CODEX_UPSTREAM_HOST,
  EVREN_MAIN_MODEL, EVREN_FAST_MODEL, EVREN_SESSION_MODELS,
  CHATGPT_MODEL_PREFIX, CHATGPT_FAMILIES, ROUTE_CHATGPT, isChatgptId, chatgptFamilyName, chatgptSpawnEnv, chatgptIdForNewSession,
  isEvrenId, evrenModelName, normalizeProviderStore, resolveActiveEntry,
  cleanEvrenKey, maskEvrenKey, evrenSpawnEnv, codexProxyOverride, splitProviderPath,
  codexLoginFromAuth, credentialHeaders, providerUpstreamHeaders, UPSTREAM_HOST,
};
