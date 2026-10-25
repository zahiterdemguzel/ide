'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const lib = require('../src/main/accounts-lib');

test('normalizeAccountStore: an empty or broken store is just the default account', () => {
  for (const raw of [null, undefined, {}, { accounts: 'nope' }, { activeId: 'ghost' }]) {
    const store = lib.normalizeAccountStore(raw);
    assert.deepEqual(store.accounts.map((a) => a.id), ['default']);
    assert.equal(store.activeId, 'default');
    assert.equal(store.accounts[0].configDir, null);
  }
});

test('normalizeAccountStore: keeps valid extra accounts, drops duplicates and folderless ones', () => {
  const store = lib.normalizeAccountStore({
    activeId: 'work',
    defaultName: 'Personal',
    accounts: [
      { id: 'work', name: ' Work ', configDir: '/h/.claude-accounts/work' },
      { id: 'work', name: 'Dupe', configDir: '/x' },
      { id: 'default', name: 'Hijack', configDir: '/y' },
      { id: 'nodir', name: 'No dir' },
      { id: 'noname', configDir: '/h/.claude-accounts/noname' },
    ],
  });
  assert.deepEqual(store.accounts, [
    { id: 'default', name: 'Personal', configDir: null },
    { id: 'work', name: 'Work', configDir: '/h/.claude-accounts/work' },
    { id: 'noname', name: 'noname', configDir: '/h/.claude-accounts/noname' },
  ]);
  assert.equal(store.activeId, 'work');
});

test('serializeAccountStore round-trips through normalizeAccountStore', () => {
  const store = lib.normalizeAccountStore({
    activeId: 'b', defaultName: 'Home',
    accounts: [{ id: 'b', name: 'B', configDir: '/b' }],
  });
  assert.deepEqual(lib.normalizeAccountStore(lib.serializeAccountStore(store)), store);
});

test('accountFolderName: slugs the name and avoids taken folders', () => {
  assert.equal(lib.accountFolderName('Work Account'), 'work-account');
  assert.equal(lib.accountFolderName('Café Çay'), 'cafe-cay');
  assert.equal(lib.accountFolderName('!!!'), 'account');
  assert.equal(lib.accountFolderName('work', ['work', 'work-2']), 'work-3');
});

test('keychainServiceFor: default uses the bare service, a config dir appends its sha256 prefix', () => {
  assert.equal(lib.keychainServiceFor(null), 'Claude Code-credentials');
  const dir = '/Users/me/.claude-accounts/work';
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(lib.keychainServiceFor(dir), `Claude Code-credentials-${hash}`);
});

test('credential and config paths follow the account folder', () => {
  assert.equal(lib.credentialsPathFor(null, '/h'), path.join('/h', '.claude', '.credentials.json'));
  assert.equal(lib.credentialsPathFor('/a', '/h'), path.join('/a', '.credentials.json'));
  assert.equal(lib.claudeJsonPathFor(null, '/h'), path.join('/h', '.claude.json'));
  assert.equal(lib.claudeJsonPathFor('/a', '/h'), path.join('/a', '.claude.json'));
});

test('accountEnv: only an extra account sets CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(lib.accountEnv({ id: 'default', configDir: null }), {});
  assert.deepEqual(lib.accountEnv({ id: 'w', configDir: '/w' }), { CLAUDE_CONFIG_DIR: '/w' });
  assert.deepEqual(lib.accountEnv(null), {});
});

test('sharedEntriesToLink: links only allowlisted entries that exist and are not already there', () => {
  const source = ['CLAUDE.md', 'projects', 'settings.json', '.credentials.json', 'policy-limits.json', 'skills'];
  const target = ['skills', '.claude.json'];
  assert.deepEqual(lib.sharedEntriesToLink(source, target), ['CLAUDE.md', 'settings.json', 'projects']);
});

test('seedAccountConfig: copies setup keys but never the login identity', () => {
  const seeded = lib.seedAccountConfig({
    hasCompletedOnboarding: true, theme: 'dark', mcpServers: { a: {} },
    oauthAccount: { emailAddress: 'x@y' }, userID: 'abc',
  });
  assert.deepEqual(seeded, { hasCompletedOnboarding: true, theme: 'dark', mcpServers: { a: {} } });
  assert.deepEqual(lib.seedAccountConfig(null), {});
});

test('planAccountMove: idle sessions move now, busy ones after their turn, others stay', () => {
  const sessions = [
    { id: 'idle', live: true, family: 'claude', accountId: 'default', state: 'completed' },
    { id: 'busy', live: true, family: 'claude', accountId: 'default', state: 'working' },
    { id: 'asking', live: true, family: 'claude', accountId: 'default', state: 'needs-input' },
    { id: 'already', live: true, family: 'claude', accountId: 'work', state: 'completed' },
    { id: 'suspended', live: false, family: 'claude', accountId: 'default', state: 'completed' },
    { id: 'codex', live: true, family: 'codex', accountId: 'default', state: 'completed' },
  ];
  assert.deepEqual(lib.planAccountMove(sessions, 'work'), { now: ['idle'], later: ['busy', 'asking'] });
});

test('shouldMoveAfterState: a deferred session moves once it settles', () => {
  const s = { live: true, family: 'claude', accountId: 'default' };
  assert.equal(lib.shouldMoveAfterState(s, 'working', 'work'), false);
  assert.equal(lib.shouldMoveAfterState(s, 'completed', 'work'), true);
  assert.equal(lib.shouldMoveAfterState(s, 'completed', 'default'), false);
  assert.equal(lib.shouldMoveAfterState({ ...s, live: false }, 'completed', 'work'), false);
});

test('classifyLogin: tells a working, renewable, expired and missing login apart', () => {
  const fresh = { expired: false, hasRefreshToken: true };
  const staleRenewable = { expired: true, hasRefreshToken: true };
  const staleFinal = { expired: true, hasRefreshToken: false };
  assert.equal(lib.classifyLogin(null, 200), 'none');
  assert.equal(lib.classifyLogin(fresh, 200), 'ok');
  assert.equal(lib.classifyLogin(fresh, 429), 'ok', 'out of usage is still a valid login');
  assert.equal(lib.classifyLogin(fresh, 401), 'expired', 'a refused, unexpired token is a revoked login');
  assert.equal(lib.classifyLogin(staleRenewable, 401), 'stale');
  assert.equal(lib.classifyLogin(staleFinal, 401), 'expired');
  assert.equal(lib.classifyLogin(staleFinal, 0), 'ok', 'offline never reads as expired');
  assert.equal(lib.classifyLogin(staleRenewable, undefined), 'stale');
});
