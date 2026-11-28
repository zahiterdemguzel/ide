// Evren and DeepSeek API keys and Codex accounts, the other tabs of the account menu next to
// the Claude accounts (see .claude/memory/accounts.md). Each provider keeps a list of
// credentials with one active entry per app instance, and the account proxy
// (account-proxy.js) puts the active entry's credentials on every request — so a
// switch needs no session restart and a turn in flight carries on.
//
// Evren entries are API keys, stored encrypted (safeStorage) in the list itself.
// Codex entries are CODEX_HOME folders under ~/.codex-accounts, each holding the
// login `codex login` wrote there; the built-in default entry is the user's own
// ~/.codex. Sessions always run in the default config — only credentials differ.

const { ipcMain, safeStorage } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendToRenderer } = require('./window');
const { cleanEnv } = require('./proc-env');
const { resolveCodex } = require('./codex');
const { authArgs: codexAuthArgs } = require('./codex-install');
const { decodeStoredApiKey, encodeStoredApiKey, accountFolderName } = require('./accounts-lib');
const lib = require('./provider-accounts-lib');

const STORE_ROOT = path.join(os.homedir(), '.claude-accounts');
const STORE_PATH = path.join(STORE_ROOT, 'providers.json');
const CODEX_ACCOUNTS_ROOT = path.join(os.homedir(), '.codex-accounts');
const DEFAULT_CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// Read on every call: several app instances share the file, and an entry one of
// them adds or removes must reach the others.
function loadStore() {
  try { return lib.normalizeProviderStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))); }
  catch { return lib.normalizeProviderStore(null); }
}

function saveStore(store) {
  fs.mkdirSync(STORE_ROOT, { recursive: true });
  const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, STORE_PATH);
}

// Which entry *this* instance runs as, per provider; set from the stored choice at launch.
const instanceActiveId = Object.fromEntries(
  Object.entries(loadStore()).map(([provider, state]) => [provider, state.activeId]),
);

function defaultCodexEntry(store) {
  return { id: lib.DEFAULT_ENTRY_ID, name: store[lib.PROVIDER_CODEX].defaultName || 'Default', homeDir: DEFAULT_CODEX_HOME };
}

function activeEntry(provider) {
  const store = loadStore();
  return lib.resolveActiveEntry(store, provider, instanceActiveId[provider], defaultCodexEntry(store));
}

// --- API-key providers (Evren, DeepSeek) ---

const KEY_PROVIDER = {
  [lib.PROVIDER_EVREN]: {
    clean: lib.cleanEvrenKey, mask: lib.maskEvrenKey, label: 'Evren',
    probe: { host: lib.EVREN_UPSTREAM_HOST, path: '/v1/quota' },
  },
  [lib.PROVIDER_DEEPSEEK]: {
    clean: lib.cleanDeepseekKey, mask: lib.maskDeepseekKey, label: 'DeepSeek',
    probe: { host: lib.DEEPSEEK_UPSTREAM_HOST, path: '/user/balance' },
  },
};

function keyOf(entry) {
  return entry ? decodeStoredApiKey(entry.secret, safeStorage) : '';
}

// The credentials the proxy sends for the provider's active key; null when there is none.
function activeKeyCredentials(provider) {
  const key = keyOf(activeEntry(provider));
  return key ? { key } : null;
}
const activeEvrenCredentials = () => activeKeyCredentials(lib.PROVIDER_EVREN);
const activeDeepseekCredentials = () => activeKeyCredentials(lib.PROVIDER_DEEPSEEK);

// { status, body } of a free, read-only call made with the key (Evren quota, DeepSeek
// balance); status 0 = unreachable, body = parsed JSON or null.
function probeKey(provider, key) {
  return new Promise((resolve) => {
    const https = require('https');
    const { host, path: probePath } = KEY_PROVIDER[provider].probe;
    const req = https.request({
      host, path: probePath, method: 'GET', timeout: 15000,
      headers: { authorization: `Bearer ${key}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: null }));
    req.end();
  });
}

// '' when the key looks usable, else an error code for the renderer to translate.
// Offline counts as usable: the first session checks it again.
async function keyProblem(provider, key) {
  if (!key) return 'invalidFormat';
  const { status } = await probeKey(provider, key);
  // Evren 403 is a valid key whose owner has not accepted Evren's terms yet (terms_not_accepted).
  return status === 401 ? 'rejected' : '';
}

async function addKey(provider, name, rawKey) {
  const key = KEY_PROVIDER[provider].clean(rawKey);
  const problem = await keyProblem(provider, key);
  if (problem) return { error: problem };
  const store = loadStore();
  const state = store[provider];
  const entry = {
    id: crypto.randomUUID(),
    name: String(name || '').trim() || `${KEY_PROVIDER[provider].label} ${state.entries.length + 1}`,
    secret: encodeStoredApiKey(key, safeStorage),
  };
  state.entries.push(entry);
  if (!state.activeId) state.activeId = entry.id;
  saveStore(store);
  if (!instanceActiveId[provider]) instanceActiveId[provider] = entry.id;
  return { entry: { id: entry.id } };
}

async function setKey(provider, id, rawKey) {
  const key = KEY_PROVIDER[provider].clean(rawKey);
  const problem = await keyProblem(provider, key);
  if (problem) return { error: problem };
  const store = loadStore();
  const entry = store[provider].entries.find((e) => e.id === id);
  if (!entry) return { error: 'unknownEntry' };
  entry.secret = encodeStoredApiKey(key, safeStorage);
  saveStore(store);
  return { ok: true };
}

// The balance line shown under a DeepSeek key ('' when it can't be read right now).
async function deepseekBalanceText(key) {
  if (!key) return '';
  const { status, body } = await probeKey(lib.PROVIDER_DEEPSEEK, key);
  return status === 200 ? lib.formatDeepseekBalance(lib.parseDeepseekBalance(body)) : '';
}

// --- Codex ---

function readCodexLogin(homeDir) {
  try { return lib.codexLoginFromAuth(JSON.parse(fs.readFileSync(path.join(homeDir, 'auth.json'), 'utf8'))); }
  catch { return null; }
}

// Runs a cheap CLI command as the account so the CLI renews a token that ran out
// from its refresh token, exactly as a session would; the proxy never refreshes
// tokens itself (refresh tokens rotate, and a renewal the CLI didn't store would
// sign the account out).
async function renewCodexLogin(homeDir) {
  const exe = await resolveCodex();
  await new Promise((resolve) => {
    execFile(exe, ['login', 'status'], {
      env: { ...cleanEnv(process.env), CODEX_HOME: homeDir }, timeout: 30000,
    }, () => resolve());
  });
}

// Usage of a Codex account's plan (its 5-hour and/or weekly window), read with the
// account's own token. null when signed out, offline or the call fails.
function fetchCodexUsage(login) {
  return new Promise((resolve) => {
    const https = require('https');
    const headers = { authorization: `Bearer ${login.accessToken}` };
    if (login.accountId) headers['chatgpt-account-id'] = login.accountId;
    const req = https.request({ host: lib.CODEX_UPSTREAM_HOST, path: '/backend-api/wham/usage', method: 'GET', timeout: 15000, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? lib.parseCodexUsage(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : null); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// The credentials the proxy sends for the active Codex account; null leaves the
// session's own in place (no usable login: better its own than a refusal).
async function activeCodexCredentials() {
  const entry = activeEntry(lib.PROVIDER_CODEX);
  if (!entry) return null;
  let login = readCodexLogin(entry.homeDir);
  if (login && login.expired && login.hasRefreshToken) {
    await renewCodexLogin(entry.homeDir);
    login = readCodexLogin(entry.homeDir);
  }
  return login && !login.expired ? login : null;
}

function addCodexAccount(name) {
  const store = loadStore();
  const codex = store[lib.PROVIDER_CODEX];
  const displayName = String(name || '').trim() || `Codex ${codex.entries.length + 2}`;
  let taken = [];
  try { taken = fs.readdirSync(CODEX_ACCOUNTS_ROOT); } catch {}
  const homeDir = path.join(CODEX_ACCOUNTS_ROOT, accountFolderName(displayName, taken));
  fs.mkdirSync(homeDir, { recursive: true });
  const entry = { id: crypto.randomUUID(), name: displayName, homeDir };
  codex.entries.push(entry);
  saveStore(store);
  return { entry: { id: entry.id } };
}

// The shell argv + env that signs a Codex account in, for an embedded terminal.
function codexLoginCommand(id) {
  const entry = id === lib.DEFAULT_ENTRY_ID ? defaultCodexEntry(loadStore())
    : loadStore()[lib.PROVIDER_CODEX].entries.find((e) => e.id === id);
  if (!entry) return null;
  return { args: codexAuthArgs(), env: { CODEX_HOME: entry.homeDir } };
}

// --- shared ---

async function describeProvider(provider) {
  const store = loadStore();
  const state = store[provider];
  const active = lib.resolveActiveEntry(store, provider, instanceActiveId[provider], defaultCodexEntry(store));
  const activeId = active ? active.id : '';
  if (lib.API_KEY_PROVIDERS.includes(provider)) {
    const entries = await Promise.all(state.entries.map(async (e) => {
      const key = keyOf(e);
      const detail = KEY_PROVIDER[provider].mask(key);
      // DeepSeek is prepaid: the remaining balance is the usage figure worth showing.
      const balance = provider === lib.PROVIDER_DEEPSEEK ? await deepseekBalanceText(key) : '';
      return { id: e.id, name: e.name, loggedIn: !!key, detail, balance };
    }));
    return { provider, activeId, entries };
  }
  const entries = await Promise.all([defaultCodexEntry(store), ...state.entries].map(async (e) => {
    const login = readCodexLogin(e.homeDir);
    const usable = !!login && (!login.expired || login.hasRefreshToken);
    // An expired token can't be used for the reading; the sign-in prompt shows instead.
    const usage = login && !login.expired ? await fetchCodexUsage(login) : null;
    return {
      id: e.id, name: e.name, loggedIn: usable, detail: login ? login.email : '',
      login: !login ? 'none' : usable ? 'ok' : 'expired', usage,
    };
  }));
  return { provider, activeId, entries };
}

function setActive(provider, id) {
  const store = loadStore();
  const known = id === lib.DEFAULT_ENTRY_ID && provider === lib.PROVIDER_CODEX
    || store[provider].entries.some((e) => e.id === id);
  if (!known || instanceActiveId[provider] === id) return instanceActiveId[provider];
  instanceActiveId[provider] = id;
  store[provider].activeId = id;
  saveStore(store);
  sendToRenderer('provider-account-changed', { provider, activeId: id });
  return id;
}

function removeEntry(provider, id) {
  if (id === lib.DEFAULT_ENTRY_ID) return;
  const store = loadStore();
  store[provider].entries = store[provider].entries.filter((e) => e.id !== id);
  if (store[provider].activeId === id) store[provider].activeId = lib.PROVIDER_CODEX === provider ? lib.DEFAULT_ENTRY_ID : (store[provider].entries[0]?.id || '');
  saveStore(store);
  // The folder (and its login) stays on disk, like removed Claude accounts: re-adding is a sign-in away.
  if (instanceActiveId[provider] === id) {
    instanceActiveId[provider] = store[provider].activeId;
    sendToRenderer('provider-account-changed', { provider, activeId: instanceActiveId[provider] });
  }
}

function renameEntry(provider, id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  const store = loadStore();
  if (provider === lib.PROVIDER_CODEX && id === lib.DEFAULT_ENTRY_ID) {
    store[provider].defaultName = trimmed;
    saveStore(store);
    return;
  }
  const entry = store[provider].entries.find((e) => e.id === id);
  if (entry) { entry.name = trimmed; saveStore(store); }
}

ipcMain.handle('providers-list', (_e, provider) => (lib.PROVIDERS.includes(provider) ? describeProvider(provider) : null));
ipcMain.handle('providers-add', (_e, { provider, name, apiKey }) => (
  lib.API_KEY_PROVIDERS.includes(provider) ? addKey(provider, name, apiKey) : addCodexAccount(name)));
ipcMain.handle('providers-set-key', (_e, { provider = lib.PROVIDER_EVREN, id, apiKey }) => (
  lib.API_KEY_PROVIDERS.includes(provider) ? setKey(provider, id, apiKey) : { error: 'unknownProvider' }));
ipcMain.handle('providers-remove', (_e, { provider, id }) => { removeEntry(provider, id); return describeProvider(provider); });
ipcMain.handle('providers-rename', (_e, { provider, id, name }) => { renameEntry(provider, id, name); return describeProvider(provider); });
ipcMain.handle('providers-set-active', (_e, { provider, id }) => setActive(provider, id));
ipcMain.handle('providers-login-command', (_e, id) => codexLoginCommand(id));

module.exports = {
  activeEvrenCredentials, activeCodexCredentials, activeDeepseekCredentials,
  hasEvrenKey: () => !!activeEvrenCredentials(),
  hasDeepseekKey: () => !!activeDeepseekCredentials(),
};
