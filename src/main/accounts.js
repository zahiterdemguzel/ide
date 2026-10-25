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

const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sharedDataDir } = require('./instance');
const { sendToRenderer } = require('./window');
const { cleanEnv } = require('./proc-env');
const { resolveClaude, readUsage, readOauthCreds, probeOauthToken, runCli } = require('./claude');
const { authArgs } = require('./claude-install');
const lib = require('./accounts-lib');

const STORE_PATH = path.join(sharedDataDir, 'accounts.json');
const ACCOUNTS_ROOT = path.join(os.homedir(), '.claude-accounts');
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');

// Read on every call rather than cached: several app instances share this file,
// and one switching accounts must be seen by the others' next spawn.
function loadStore() {
  try { return lib.normalizeAccountStore(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))); }
  catch { return lib.normalizeAccountStore(null); }
}

function saveStore(store) {
  const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(lib.serializeAccountStore(store), null, 2));
  fs.renameSync(tmpPath, STORE_PATH);
}

function activeAccount() {
  const store = loadStore();
  return store.accounts.find((a) => a.id === store.activeId) || store.accounts[0];
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

function addAccount(name) {
  const store = loadStore();
  const displayName = String(name || '').trim() || `Account ${store.accounts.length + 1}`;
  let taken = [];
  try { taken = fs.readdirSync(ACCOUNTS_ROOT); } catch {}
  const configDir = path.join(ACCOUNTS_ROOT, lib.accountFolderName(displayName, taken));
  const account = { id: crypto.randomUUID(), name: displayName, configDir };
  fs.mkdirSync(configDir, { recursive: true });
  seedClaudeJson(configDir);
  linkSharedConfig(account);
  store.accounts.push(account);
  saveStore(store);
  return account;
}

// Forgets the account but leaves its folder (and Keychain login) on disk: the
// folder is full of links into ~/.claude, and a recursive delete is not worth
// the risk to the user's real config. Re-adding is a quick login away.
function removeAccount(id) {
  if (id === lib.DEFAULT_ACCOUNT_ID) return loadStore();
  // Removing the active account switches back to the default one first, so open
  // sessions move off it like any other switch.
  if (loadStore().activeId === id) setActiveAccount(lib.DEFAULT_ACCOUNT_ID);
  const store = loadStore();
  store.accounts = store.accounts.filter((a) => a.id !== id);
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

// Listeners told when the active account changes (sessions.js moves live sessions).
const activeListeners = new Set();
function onActiveAccountChanged(cb) { activeListeners.add(cb); }

function setActiveAccount(id) {
  const store = loadStore();
  if (!store.accounts.some((a) => a.id === id) || store.activeId === id) return store;
  store.activeId = id;
  saveStore(store);
  for (const cb of activeListeners) {
    try { cb(id); } catch (err) { console.error('[accounts] active-change listener failed', err); }
  }
  sendToRenderer('account-changed', { activeId: id });
  return store;
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
  let creds = readOauthCreds(account.configDir);
  let login = lib.classifyLogin(creds, creds ? await probeOauthToken(creds.accessToken) : null);
  if (login === 'stale') {
    await runCli('.', { configDir: account.configDir });
    creds = readOauthCreds(account.configDir);
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
    const status = await authStatus(a);
    if (!status.loggedIn) return { ...status, login: 'none', loginStamp: 0 };
    const { login, loginStamp } = await loginHealth(a, recheck);
    // Signed in by a means we can't read (an API key, an unreadable Keychain) reads as fine.
    const state = login === 'none' ? 'ok' : login;
    return { ...status, loggedIn: state === 'ok', login: state, loginStamp };
  }));
  return {
    activeId: store.activeId,
    accounts: store.accounts.map((a, i) => ({ id: a.id, name: a.name, configDir: a.configDir, ...results[i] })),
  };
}

// The shell argv + env that signs an account in, for an embedded terminal.
function loginCommand(id) {
  const account = accountById(id);
  if (!account) return null;
  loginChecks.delete(id); // a fresh login is about to replace the checked one
  linkSharedConfig(account);
  const args = authArgs().slice();
  // authArgs ends in a bare `claude`; sign-in is `claude auth login`.
  args[args.length - 1] = args[args.length - 1].replace(/claude$/, 'claude auth login');
  return { args, env: lib.accountEnv(account) };
}

ipcMain.handle('accounts-list', (_e, opts) => describeAccounts(opts || {}));
ipcMain.handle('accounts-add', (_e, name) => addAccount(name));
ipcMain.handle('accounts-remove', (_e, id) => { removeAccount(id); return describeAccounts(); });
ipcMain.handle('accounts-rename', (_e, { id, name }) => { renameAccount(id, name); return describeAccounts(); });
ipcMain.handle('accounts-set-active', (_e, id) => setActiveAccount(id).activeId);
ipcMain.handle('accounts-login-command', (_e, id) => loginCommand(id));
// Each account's subscription usage, for picking which one to switch to. One
// 1-token Messages call per signed-in account, so it's fetched only on demand.
ipcMain.handle('accounts-usage', async () => {
  const store = loadStore();
  const usages = await Promise.all(store.accounts.map((a) => readUsage(a.configDir).catch(() => null)));
  return Object.fromEntries(store.accounts.map((a, i) => [a.id, usages[i]]));
});

module.exports = { activeAccount, accountById, linkSharedConfig, onActiveAccountChanged };
