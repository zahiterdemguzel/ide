// Multiple Claude accounts on one machine, switchable from the toolbar without
// signing out (see .claude/memory/accounts.md). Every extra account is its own
// Claude Code config folder under ~/.claude-accounts/<name>, selected by the
// CLI's CLAUDE_CONFIG_DIR env var, so each keeps its own login side by side.
// The shared parts of the default ~/.claude (rules, settings, plugins, session
// transcripts) are symlinked in, so every account behaves like the user's normal
// setup and a session can resume its conversation after switching accounts.
//
// The pure logic lives in accounts-lib.js; this file owns the disk, the CLI calls
// and the IPC surface. Accounts are a desktop-only concern, so the channels use
// ipcMain directly rather than the remote bridge.

const { ipcMain, safeStorage } = require('electron');
const bridge = require('./remote-bridge');
const { execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sharedDataDir } = require('./instance');
const { sendToRenderer } = require('./window');
const { cleanEnv } = require('./proc-env');
const { resolveClaude, readUsage, readOauthCreds, readOauthCredsAsync, probeOauthToken, runCli } = require('./claude');
const { authArgs } = require('./claude-install');
const lib = require('./accounts-lib');
const spend = require('./api-spend-lib');

const ACCOUNTS_ROOT = path.join(os.homedir(), '.claude-accounts');
// The list lives beside the account folders, not in the app's data folder: the dev
// build and the installed app each have their own data folder (`-dev` suffix, see
// instance.js), so a list kept there vanished whenever the other build was opened.
const STORE_PATH = path.join(ACCOUNTS_ROOT, 'accounts.json');
// Where earlier builds kept the list: this build's data folder and its dev/packaged twin.
const LEGACY_STORE_PATHS = [
  path.join(sharedDataDir, 'accounts.json'),
  path.join(sharedDataDir.endsWith('-dev') ? sharedDataDir.slice(0, -4) : `${sharedDataDir}-dev`, 'accounts.json'),
];
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');

// Read on every call rather than cached: several app instances share this file,
// and an account one of them adds, renames or removes must reach the others.
function loadStore() {
  try { return lib.normalizeAccountStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))); }
  catch { return lib.normalizeAccountStore(null); }
}

function saveStore(store) {
  fs.mkdirSync(ACCOUNTS_ROOT, { recursive: true });
  const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(lib.serializeAccountStore(store), null, 2));
  fs.renameSync(tmpPath, STORE_PATH);
}

// Which account *this* app instance runs as. Every instance makes its own choice:
// switching in one window never moves another window's sessions. The store's
// `activeId` only remembers the latest choice, so a newly opened instance starts
// on it. Set once the store has been restored (below).
let instanceActiveId = lib.DEFAULT_ACCOUNT_ID;

function activeAccount() {
  return lib.resolveActiveAccount(loadStore(), instanceActiveId);
}

function accountById(id) {
  return loadStore().accounts.find((a) => a.id === id) || null;
}

// Symlink the shared parts of ~/.claude into an account folder. Runs before every
// spawn (cheap: two readdirs) so something the user adds to ~/.claude later — a
// first skill, a new plugins folder — reaches the other accounts too. Windows
// directories use junctions, which need no admin rights; a file link that the OS
// refuses is skipped rather than failing the session.
function linkSharedConfig(account) {
  if (!account || !account.configDir) return;
  let sourceNames;
  let targetNames;
  try {
    fs.mkdirSync(account.configDir, { recursive: true });
    sourceNames = fs.readdirSync(DEFAULT_CONFIG_DIR);
    targetNames = fs.readdirSync(account.configDir);
  } catch { return; }
  for (const name of lib.sharedEntriesToLink(sourceNames, targetNames)) {
    const source = path.join(DEFAULT_CONFIG_DIR, name);
    try {
      const isDir = fs.statSync(source).isDirectory();
      fs.symlinkSync(source, path.join(account.configDir, name), isDir ? 'junction' : 'file');
    } catch (err) {
      console.warn(`[accounts] could not share ${name}:`, err.message);
    }
  }
}

// A new account's own .claude.json, seeded from the default one so it skips the
// CLI's first-run onboarding and keeps the user's MCP servers and trusted folders.
function seedClaudeJson(configDir) {
  const target = lib.claudeJsonPathFor(configDir, os.homedir());
  if (fs.existsSync(target)) return;
  let defaultConfig = {};
  try { defaultConfig = JSON.parse(fs.readFileSync(lib.claudeJsonPathFor(null, os.homedir()), 'utf8')); } catch {}
  fs.writeFileSync(target, JSON.stringify(lib.seedAccountConfig(defaultConfig), null, 2));
}

// --- API-key accounts ---
// The key lives in the account's own folder (encrypted with the OS keystore via
// safeStorage when available) and reaches the CLI as ANTHROPIC_API_KEY at spawn.

function apiKeyPath(configDir) {
  return path.join(configDir, lib.API_KEY_FILE);
}

function readApiKey(account) {
  if (!lib.isApiKeyAccount(account) || !account.configDir) return '';
  try { return lib.decodeStoredApiKey(fs.readFileSync(apiKeyPath(account.configDir), 'utf8'), safeStorage); }
  catch { return ''; }
}

// Writes the key and pre-approves it in the account's .claude.json, so sessions
// start without the CLI's "use this API key?" question.
function writeApiKey(configDir, apiKey) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(apiKeyPath(configDir), lib.encodeStoredApiKey(apiKey, safeStorage), { mode: 0o600 });
  const configPath = lib.claudeJsonPathFor(configDir, os.homedir());
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const tmpPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(lib.approveApiKeyInConfig(config, apiKey), null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

// HTTP status of a free call (list models) made with the key; 0 = unreachable.
function probeApiKey(apiKey) {
  return new Promise((resolve) => {
    const req = https.request('https://api.anthropic.com/v1/models?limit=1', {
      method: 'GET', timeout: 15000,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

// '' when the key looks usable, else an error code for the renderer to translate.
// Offline counts as usable: the key is checked again by the first session anyway.
async function apiKeyProblem(apiKey) {
  if (!apiKey) return 'invalidFormat';
  const status = await probeApiKey(apiKey);
  return status === 401 || status === 403 ? 'rejected' : '';
}

// The env a CLI needs to run as the account with this config folder (null: the
// default account): its CLAUDE_CONFIG_DIR, plus ANTHROPIC_API_KEY for an API-key
// account. Used for sessions and for the one-off `claude -p` runs.
function accountEnvForConfigDir(configDir) {
  const account = configDir ? loadStore().accounts.find((a) => a.configDir === configDir) : null;
  return account ? spawnEnv(account) : lib.accountEnv({ configDir });
}

function spawnEnv(account) {
  return lib.accountEnv(account, readApiKey(account));
}

// --- spending limit (API-key accounts) ---
// `<folder>/.ide-budget.json` holds the limit and what was spent against it; the
// account proxy adds every metered response's cost (see account-proxy.js).

const BUDGET_FILE = '.ide-budget.json';

function budgetPath(configDir) {
  return path.join(configDir, BUDGET_FILE);
}

function readBudgetOf(account) {
  let raw = null;
  if (account && account.configDir) {
    try { raw = JSON.parse(fs.readFileSync(budgetPath(account.configDir), 'utf8')); } catch {}
  }
  return spend.currentBudget(raw, Date.now());
}

function readBudget(accountId) {
  return readBudgetOf(accountById(accountId));
}

function writeBudget(account, budget) {
  const file = budgetPath(account.configDir);
  const tmpPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(budget, null, 2));
  fs.renameSync(tmpPath, file);
}

// Read-modify-write per response: a few bytes, and re-reading each time keeps
// spend recorded by other app instances.
function updateBudget(accountId, change) {
  const account = accountById(accountId);
  if (!lib.isApiKeyAccount(account)) return null;
  const next = change(readBudgetOf(account), Date.now());
  try { writeBudget(account, next); } catch (err) { console.warn('[accounts] could not save the spend:', err.message); }
  return next;
}

function recordApiSpend(accountId, usd) {
  if (usd > 0) updateBudget(accountId, (budget, now) => spend.addSpend(budget, usd, now));
}

// The usage reading of any account: the subscription windows of a login, the
// spending limit of an API-key account (null without a limit).
async function accountUsage(account) {
  if (lib.isApiKeyAccount(account)) return spend.budgetUsageView(readBudgetOf(account), Date.now());
  return readUsage(account.configDir).catch(() => null);
}

// `options`: { kind: 'claude' | 'apiKey', apiKey } — an API-key account is only
// created once its key checks out; resolves { account } or { error }.
async function addAccount(name, options = {}) {
  const kind = lib.cleanAccountKind(options.kind);
  const apiKey = lib.cleanApiKey(options.apiKey);
  if (kind === lib.ACCOUNT_KIND_API_KEY) {
    const problem = await apiKeyProblem(apiKey);
    if (problem) return { error: problem };
  }
  const store = loadStore();
  const displayName = String(name || '').trim() || `Account ${store.accounts.length + 1}`;
  let taken = [];
  try { taken = fs.readdirSync(ACCOUNTS_ROOT); } catch {}
  const configDir = path.join(ACCOUNTS_ROOT, lib.accountFolderName(displayName, taken));
  // The unattended auto-switch never picks an API-key account: it bills per token.
  const account = { id: crypto.randomUUID(), name: displayName, configDir, autoSwitch: kind !== lib.ACCOUNT_KIND_API_KEY, kind };
  fs.mkdirSync(configDir, { recursive: true });
  seedClaudeJson(configDir);
  if (kind === lib.ACCOUNT_KIND_API_KEY) writeApiKey(configDir, apiKey);
  linkSharedConfig(account);
  store.accounts.push(account);
  store.removedDirs = store.removedDirs.filter((dir) => dir !== configDir);
  saveStore(store);
  return { account };
}

// Replaces an API-key account's key; resolves { ok } or { error }. Sessions pick
// it up on their next spawn.
async function setAccountApiKey(id, rawKey) {
  const account = accountById(id);
  if (!lib.isApiKeyAccount(account)) return { error: 'notApiKeyAccount' };
  const apiKey = lib.cleanApiKey(rawKey);
  const problem = await apiKeyProblem(apiKey);
  if (problem) return { error: problem };
  writeApiKey(account.configDir, apiKey);
  return { ok: true };
}

// Forgets the account but leaves its folder (and Keychain login) on disk: the
// folder is full of links into ~/.claude, and a recursive delete is not worth
// the risk to the user's real config. Re-adding is a quick login away.
function removeAccount(id) {
  if (id === lib.DEFAULT_ACCOUNT_ID) return loadStore();
  // Removing the active account switches back to the default one first, so open
  // sessions move off it like any other switch.
  if (activeAccount().id === id) setActiveAccount(lib.DEFAULT_ACCOUNT_ID);
  const store = loadStore();
  const removed = store.accounts.find((a) => a.id === id);
  store.accounts = store.accounts.filter((a) => a.id !== id);
  // Remembered so startup recovery doesn't bring it back from its folder.
  if (removed && removed.configDir) store.removedDirs = [...store.removedDirs, removed.configDir];
  saveStore(store);
  return store;
}

function renameAccount(id, name) {
  const store = loadStore();
  const account = store.accounts.find((a) => a.id === id);
  const trimmed = String(name || '').trim();
  if (account && trimmed) { account.name = trimmed; saveStore(store); }
  return store;
}

// Whether the unattended auto-switch may pick this account. Turned off for
// accounts the user wants to spend sparingly; manual switching is unaffected.
function setAccountAutoSwitch(id, allowed) {
  const store = loadStore();
  const account = store.accounts.find((a) => a.id === id);
  if (account) { account.autoSwitch = !!allowed; saveStore(store); }
  return store;
}

// Listeners told when this instance's active account changes (sessions.js and the
// account proxy follow it).
const activeListeners = new Set();
function onActiveAccountChanged(cb) { activeListeners.add(cb); }

function setActiveAccount(id) {
  const store = loadStore();
  if (!store.accounts.some((a) => a.id === id) || activeAccount().id === id) return activeAccount().id;
  instanceActiveId = id;
  store.activeId = id;
  saveStore(store);
  for (const cb of activeListeners) {
    try { cb(id); } catch (err) { console.error('[accounts] active-change listener failed', err); }
  }
  sendToRenderer('account-changed', { activeId: id });
  return id;
}

// `claude auth status --json` run as the account: whether it is signed in, and as
// whom. Never rejects; an unreachable CLI reads as signed out.
async function authStatus(account) {
  const exe = await resolveClaude();
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status', '--json'], {
      env: { ...cleanEnv(process.env), ...lib.accountEnv(account) }, timeout: 15000, encoding: 'utf8',
    }, (_err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        resolve({ loggedIn: !!s.loggedIn, email: s.email || '', orgName: s.orgName || '', plan: s.subscriptionType || '' });
      } catch { resolve({ loggedIn: false, email: '', orgName: '', plan: '' }); }
    });
  });
}

// Whether an account's login still works. `claude auth status` only checks that
// credentials are stored, so it can't see an expired login; this makes one 1-token
// API call with the stored token. A token that merely ran out is first handed to
// the CLI for a one-line run, which renews it from the refresh token the way a
// session would — only a login that still fails after that counts as expired.
// Cached per account so polling the list doesn't spend a call each time.
const LOGIN_CHECK_TTL_MS = 5 * 60 * 1000;
const loginChecks = new Map(); // account id -> { at, login, loginStamp }

async function checkLogin(account) {
  let creds = await readOauthCredsAsync(account.configDir);
  let login = lib.classifyLogin(creds, creds ? await probeOauthToken(creds.accessToken) : null);
  if (login === 'stale') {
    await runCli('.', { configDir: account.configDir });
    creds = await readOauthCredsAsync(account.configDir);
    login = creds && !creds.expired ? 'ok' : 'expired';
  }
  return { login, loginStamp: creds ? creds.expiresAt : 0 };
}

async function loginHealth(account, recheck) {
  const cached = loginChecks.get(account.id);
  if (cached && !recheck && Date.now() - cached.at < LOGIN_CHECK_TTL_MS) return cached;
  const result = { at: Date.now(), ...(await checkLogin(account)) };
  loginChecks.set(account.id, result);
  return result;
}

// The store plus each account's login state, for the toolbar menu. `login` is
// 'ok' | 'expired' | 'none' (see classifyLogin); `loggedIn` means usable right now,
// so an expired account reads as needing a sign-in everywhere that checks it.
// `recheck` skips the cache — used when the active account's usage reading
// suddenly fails, the first sign its login may have lapsed.
async function describeAccounts({ recheck = false } = {}) {
  const store = loadStore();
  const results = await Promise.all(store.accounts.map(async (a) => {
    if (lib.isApiKeyAccount(a)) return describeApiKeyAccount(a);
    const status = await authStatus(a);
    if (!status.loggedIn) return { ...status, login: 'none', loginStamp: 0 };
    const { login, loginStamp } = await loginHealth(a, recheck);
    // Signed in by a means we can't read (an API key, an unreadable Keychain) reads as fine.
    const state = login === 'none' ? 'ok' : login;
    return { ...status, loggedIn: state === 'ok', login: state, loginStamp };
  }));
  return {
    activeId: lib.resolveActiveAccount(store, instanceActiveId).id,
    accounts: store.accounts.map((a, i) => ({
      id: a.id, name: a.name, configDir: a.configDir, autoSwitch: a.autoSwitch !== false, kind: a.kind, ...results[i],
    })),
  };
}

// An API-key account has no login to check: it's usable while it holds a key,
// shown masked in place of an email.
function describeApiKeyAccount(account) {
  const apiKey = readApiKey(account);
  const budget = readBudgetOf(account);
  return {
    loggedIn: !!apiKey, email: lib.maskApiKey(apiKey), orgName: '', plan: '',
    login: apiKey ? 'ok' : 'none', loginStamp: 0,
    budget: { limitUsd: budget.limitUsd, period: budget.period, spentUsd: budget.spentUsd },
  };
}

// The shell argv + env that signs an account in, for an embedded terminal.
// API-key accounts have no CLI login (the renderer asks for a key instead).
function loginCommand(id) {
  const account = accountById(id);
  if (!account || lib.isApiKeyAccount(account)) return null;
  loginChecks.delete(id); // a fresh login is about to replace the checked one
  linkSharedConfig(account);
  const args = authArgs().slice();
  // authArgs ends in a bare `claude`; sign-in is `claude auth login`.
  args[args.length - 1] = args[args.length - 1].replace(/claude$/, 'claude auth login');
  return { args, env: lib.accountEnv(account) };
}

// First run of a build with the new store location: carry over the newest list an
// earlier build saved in an app data folder.
function migrateLegacyStore() {
  if (fs.existsSync(STORE_PATH)) return;
  const newest = LEGACY_STORE_PATHS
    .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return;
  try { saveStore(lib.normalizeAccountStore(JSON.parse(fs.readFileSync(newest.file, 'utf8')))); }
  catch (err) { console.warn('[accounts] could not migrate the account list:', err.message); }
}

// Every account folder under ~/.claude-accounts that still holds a login.
function signedInAccountFolders() {
  let entries = [];
  try { entries = fs.readdirSync(ACCOUNTS_ROOT, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => {
    const configDir = path.join(ACCOUNTS_ROOT, e.name);
    let claudeJson = null;
    try { claudeJson = JSON.parse(fs.readFileSync(lib.claudeJsonPathFor(configDir, os.homedir()), 'utf8')); } catch {}
    const hasApiKey = fs.existsSync(apiKeyPath(configDir));
    return { folderName: e.name, configDir, signedIn: !!readOauthCreds(configDir), hasApiKey, claudeJson };
  });
}

// Once per launch: logins outlive the list, so a list that lost an account
// (an older build, a wiped data folder) gets it back from its folder.
function restoreAccounts() {
  migrateLegacyStore();
  const store = loadStore();
  const recovered = lib.recoverAccounts(store, signedInAccountFolders());
  if (recovered !== store) saveStore(recovered);
}
try { restoreAccounts(); } catch (err) { console.warn('[accounts] could not restore accounts:', err.message); }
instanceActiveId = loadStore().activeId;

bridge.handle('accounts-list', (_e, opts) => describeAccounts(opts || {}));
ipcMain.handle('accounts-add', (_e, { name, kind, apiKey } = {}) => addAccount(name, { kind, apiKey }));
ipcMain.handle('accounts-set-api-key', (_e, { id, apiKey }) => setAccountApiKey(id, apiKey));
ipcMain.handle('accounts-remove', (_e, id) => { removeAccount(id); return describeAccounts(); });
ipcMain.handle('accounts-rename', (_e, { id, name }) => { renameAccount(id, name); return describeAccounts(); });
ipcMain.handle('accounts-set-auto-switch', (_e, { id, allowed }) => { setAccountAutoSwitch(id, allowed); return describeAccounts(); });
bridge.handle('accounts-set-active', (_e, id) => setActiveAccount(id));
ipcMain.handle('accounts-login-command', (_e, id) => loginCommand(id));
// Each account's subscription usage, for picking which one to switch to. One
// 1-token Messages call per signed-in account, so it's fetched only on demand.
// `{ limitUsd, period }` sets an API-key account's spending limit (0 = none);
// `{ reset: true }` starts its spend over at $0.
ipcMain.handle('accounts-set-budget', (_e, { id, limitUsd, period, reset }) => {
  updateBudget(id, (budget, now) => (reset ? spend.resetSpend(budget, now) : spend.withLimit(budget, { limitUsd, period }, now)));
  return describeAccounts();
});
bridge.handle('accounts-usage', async () => {
  const store = loadStore();
  const usages = await Promise.all(store.accounts.map(accountUsage));
  return Object.fromEntries(store.accounts.map((a, i) => [a.id, usages[i]]));
});

module.exports = {
  activeAccount, accountById, linkSharedConfig, onActiveAccountChanged, spawnEnv, accountEnvForConfigDir,
  readBudget, recordApiSpend, accountUsage,
};
