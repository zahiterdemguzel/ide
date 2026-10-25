'use strict';

// Pure, Electron-free logic behind multiple Claude accounts (see accounts.js and
// .claude/memory/accounts.md). Unit-tested in test/accounts-lib.test.js.
//
// Each extra account is its own Claude Code config folder, selected with the
// CLI's CLAUDE_CONFIG_DIR env var: the folder holds that account's login, so
// switching accounts is just spawning the CLI with a different folder. The
// built-in "default" account is the user's normal setup (no env override).

const crypto = require('crypto');
const path = require('path');

const DEFAULT_ACCOUNT_ID = 'default';
const KEYCHAIN_BASE_SERVICE = 'Claude Code-credentials';

// Entries of the default config folder that every account shares through a
// symlink, so a second account keeps the user's rules, settings, plugins and
// skills — and, crucially, the same `projects/` transcripts, which is what lets
// a running session resume its conversation after moving to another account.
// An allowlist on purpose: anything tied to one login or one org (credentials,
// .claude.json's oauthAccount, policy/remote settings, telemetry) stays private.
const SHARED_CONFIG_ENTRIES = [
  'CLAUDE.md', 'settings.json', 'keybindings.json',
  'agents', 'commands', 'skills', 'plugins', 'hooks', 'output-styles',
  'projects', 'file-history', 'todos', 'plans', 'history.jsonl',
];

// Keys of the default `.claude.json` copied into a new account's own config, so
// it skips first-run onboarding and keeps the user's MCP servers and per-project
// trust. Login identity (oauthAccount, userID) is deliberately not among them.
const SEEDED_CONFIG_KEYS = [
  'hasCompletedOnboarding', 'lastOnboardingVersion', 'theme', 'editorMode',
  'mcpServers', 'projects', 'autoUpdates', 'installMethod',
];

function defaultAccount() {
  return { id: DEFAULT_ACCOUNT_ID, name: 'Default', configDir: null };
}

// Whatever was on disk → a well-formed store: the default account always first,
// no duplicate ids, every extra account with a name and a folder, and an active
// id that names an account that exists. `removedDirs` lists the folders of
// accounts the user removed, so recovery (recoverAccounts) never re-adds them.
function normalizeAccountStore(raw) {
  const accounts = [defaultAccount()];
  const seen = new Set([DEFAULT_ACCOUNT_ID]);
  for (const a of (raw && Array.isArray(raw.accounts) ? raw.accounts : [])) {
    if (!a || typeof a.id !== 'string' || seen.has(a.id)) continue;
    if (a.id === DEFAULT_ACCOUNT_ID) continue;
    if (typeof a.configDir !== 'string' || !a.configDir) continue;
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : a.id;
    accounts.push({ id: a.id, name, configDir: a.configDir });
    seen.add(a.id);
  }
  if (raw && typeof raw.defaultName === 'string' && raw.defaultName.trim()) {
    accounts[0].name = raw.defaultName.trim();
  }
  const activeId = raw && seen.has(raw.activeId) ? raw.activeId : DEFAULT_ACCOUNT_ID;
  const removedDirs = raw && Array.isArray(raw.removedDirs)
    ? [...new Set(raw.removedDirs.filter((d) => typeof d === 'string' && d))]
    : [];
  return { accounts, activeId, removedDirs };
}

// The store as written to disk (the default account is implied, only its name kept).
function serializeAccountStore(store) {
  return {
    activeId: store.activeId,
    defaultName: store.accounts[0].name,
    accounts: store.accounts.slice(1).map(({ id, name, configDir }) => ({ id, name, configDir })),
    removedDirs: store.removedDirs || [],
  };
}

// A filesystem-safe folder name for an account, unique among `takenNames`.
function accountFolderName(displayName, takenNames = []) {
  const base = String(displayName || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';
  const taken = new Set(takenNames);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// The macOS Keychain service the CLI stores a login under. With CLAUDE_CONFIG_DIR
// set it appends the first 8 hex chars of sha256(config dir) — read off the CLI
// bundle (2.1.x) — so every config folder gets its own Keychain entry.
function keychainServiceFor(configDir) {
  if (!configDir) return KEYCHAIN_BASE_SERVICE;
  const hash = crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex');
  return `${KEYCHAIN_BASE_SERVICE}-${hash.slice(0, 8)}`;
}

// Where the CLI keeps the credentials file on Linux/Windows for this account.
function credentialsPathFor(configDir, homeDir) {
  return path.join(configDir || path.join(homeDir, '.claude'), '.credentials.json');
}

// Where the CLI keeps its main config (trusted folders, onboarding) for this account.
function claudeJsonPathFor(configDir, homeDir) {
  return configDir ? path.join(configDir, '.claude.json') : path.join(homeDir, '.claude.json');
}

// The env a spawned CLI needs to run as `account` ({} for the default account).
function accountEnv(account) {
  return account && account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {};
}

// Which shared entries still need a symlink in an account folder: present in the
// source folder and not yet present (as anything) in the account folder.
function sharedEntriesToLink(sourceNames, targetNames) {
  const source = new Set(sourceNames);
  const target = new Set(targetNames);
  return SHARED_CONFIG_ENTRIES.filter((name) => source.has(name) && !target.has(name));
}

// The `.claude.json` a fresh account starts from.
function seedAccountConfig(defaultConfig) {
  const seeded = {};
  for (const key of SEEDED_CONFIG_KEYS) {
    if (defaultConfig && defaultConfig[key] !== undefined) seeded[key] = defaultConfig[key];
  }
  return seeded;
}

// A session is mid-turn (or waiting on the user mid-turn) in these states; moving
// it to another account then would cut the turn off, so the move waits for it.
const BUSY_STATES = new Set(['working', 'bg-agents', 'needs-input']);

// Which live sessions must move to `activeId`, split into those that can restart
// now and those to move once their turn ends. Only Claude sessions carry an
// account (Codex and local models don't log in to Claude).
function planAccountMove(sessions, activeId) {
  const now = [];
  const later = [];
  for (const s of sessions) {
    if (!s.live || s.family !== 'claude' || !s.accountId || s.accountId === activeId) continue;
    (BUSY_STATES.has(s.state) ? later : now).push(s.id);
  }
  return { now, later };
}

// Whether a session should move to the active account right after settling into `state`.
function shouldMoveAfterState(session, state, activeId) {
  return !!(session && session.live && session.family === 'claude' && session.accountId
    && session.accountId !== activeId && !BUSY_STATES.has(state));
}

// The state of an account's stored login, from its credentials (pickOauthCreds) and
// the HTTP status of a 1-token call made with them (`probeStatus`; 0 = unreachable):
//   'none'     — no Claude login stored (never signed in, or an API-key setup)
//   'ok'       — the token works, or we couldn't tell (offline never reads as expired)
//   'stale'    — the access token ran out but a refresh token exists; the CLI renews
//                it on its next run, so try that before calling it expired
//   'expired'  — the API refuses the login, or it can't be renewed: sign in again
function classifyLogin(creds, probeStatus) {
  if (!creds) return 'none';
  if (probeStatus === 0) return 'ok';
  if (probeStatus === 401) return creds.expired && creds.hasRefreshToken ? 'stale' : 'expired';
  if (creds.expired) return creds.hasRefreshToken ? 'stale' : 'expired';
  return 'ok';
}

// A readable name for an account folder found on disk but missing from the list:
// the org it belongs to, or the email for a personal plan (whose org is just
// "<email>'s Organization"), else the folder name.
function discoveredAccountName(claudeJson, folderName) {
  const oauth = claudeJson && claudeJson.oauthAccount;
  const org = oauth && typeof oauth.organizationName === 'string' ? oauth.organizationName.trim() : '';
  if (org && !/'s Organization$/.test(org)) return org;
  if (oauth && oauth.emailAddress) return oauth.emailAddress;
  return String(folderName || 'account').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Put back every signed-in account folder the list doesn't know about — the list
// got lost (another build of the app, a wiped app-data folder) but the logins
// didn't. Folders of accounts the user removed stay removed. `folders` are { folderName, configDir, signedIn, claudeJson }. The id is
// derived from the folder so two app windows recovering at once agree on it.
// Returns the store unchanged (same object) when nothing was missing.
function recoverAccounts(store, folders) {
  const known = new Set([...store.accounts.map((a) => a.configDir).filter(Boolean), ...(store.removedDirs || [])]);
  const ids = new Set(store.accounts.map((a) => a.id));
  const recovered = [];
  for (const f of folders) {
    if (!f.signedIn || known.has(f.configDir)) continue;
    const id = `dir-${f.folderName}`;
    if (ids.has(id)) continue;
    recovered.push({ id, name: discoveredAccountName(f.claudeJson, f.folderName), configDir: f.configDir });
    ids.add(id);
  }
  return recovered.length ? { ...store, accounts: [...store.accounts, ...recovered] } : store;
}

module.exports = {
  discoveredAccountName, recoverAccounts,
  classifyLogin,
  DEFAULT_ACCOUNT_ID, KEYCHAIN_BASE_SERVICE, SHARED_CONFIG_ENTRIES, SEEDED_CONFIG_KEYS,
  normalizeAccountStore, serializeAccountStore, accountFolderName,
  keychainServiceFor, credentialsPathFor, claudeJsonPathFor, accountEnv,
  sharedEntriesToLink, seedAccountConfig, planAccountMove, shouldMoveAfterState,
};
