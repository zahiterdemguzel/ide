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
    { id: 'default', name: 'Personal', configDir: null, autoSwitch: true, kind: 'claude' },
    { id: 'work', name: 'Work', configDir: '/h/.claude-accounts/work', autoSwitch: true, kind: 'claude' },
    { id: 'noname', name: 'noname', configDir: '/h/.claude-accounts/noname', autoSwitch: true, kind: 'claude' },
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

test('normalizeAccountStore: auto-switch is allowed unless turned off, for the default account too', () => {
  const store = lib.normalizeAccountStore({
    defaultAutoSwitch: false,
    accounts: [
      { id: 'sparing', name: 'Sparing', configDir: '/s', autoSwitch: false },
      { id: 'legacy', name: 'Legacy', configDir: '/l' },
    ],
  });
  assert.deepEqual(store.accounts.map((a) => a.autoSwitch), [false, false, true]);
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
    { id: 'proxied', live: true, family: 'claude', accountId: 'default', proxied: true, state: 'completed' },
  ];
  assert.deepEqual(lib.planAccountMove(sessions, 'work'), { now: ['idle'], later: ['busy', 'asking'] });
});

test('shouldMoveAfterState: a session behind the account proxy never restarts', () => {
  const s = { live: true, family: 'claude', accountId: 'default', proxied: true };
  assert.equal(lib.shouldMoveAfterState(s, 'completed', 'work'), false);
});

test('resolveActiveAccount: the instance choice, or the default once that account is gone', () => {
  const store = lib.normalizeAccountStore({ accounts: [{ id: 'work', name: 'Work', configDir: '/w' }] });
  assert.equal(lib.resolveActiveAccount(store, 'work').id, 'work');
  assert.equal(lib.resolveActiveAccount(store, 'removed-elsewhere').id, 'default');
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

test('discoveredAccountName: org name, else email for a personal org, else the folder', () => {
  assert.equal(lib.discoveredAccountName({ oauthAccount: { organizationName: 'Halfblood Studio', emailAddress: 'a@b' } }, 'x'), 'Halfblood Studio');
  assert.equal(lib.discoveredAccountName({ oauthAccount: { organizationName: "me@x.com's Organization", emailAddress: 'me@x.com' } }, 'x'), 'me@x.com');
  assert.equal(lib.discoveredAccountName(null, 'better-meeting-rooms'), 'Better Meeting Rooms');
});

test('recoverAccounts: re-adds signed-in folders the list lost, nothing else', () => {
  const store = lib.normalizeAccountStore({
    activeId: 'kept', accounts: [{ id: 'kept', name: 'Kept', configDir: '/r/kept' }],
  });
  const folders = [
    { folderName: 'kept', configDir: '/r/kept', signedIn: true, claudeJson: null },
    { folderName: 'lost', configDir: '/r/lost', signedIn: true, claudeJson: { oauthAccount: { organizationName: 'Lost Org' } } },
    { folderName: 'never', configDir: '/r/never', signedIn: false, claudeJson: null },
  ];
  const next = lib.recoverAccounts(store, folders);
  assert.deepEqual(next.accounts.map((a) => a.id), ['default', 'kept', 'dir-lost']);
  assert.equal(next.accounts[2].name, 'Lost Org');
  assert.equal(next.activeId, 'kept');
  // Idempotent: a second pass finds nothing new and hands back the same store.
  assert.equal(lib.recoverAccounts(next, folders), next);
});

test('recoverAccounts: an account the user removed stays removed', () => {
  const store = lib.normalizeAccountStore({ removedDirs: ['/r/gone', 7] });
  assert.deepEqual(store.removedDirs, ['/r/gone']);
  const folders = [{ folderName: 'gone', configDir: '/r/gone', signedIn: true, claudeJson: null }];
  assert.equal(lib.recoverAccounts(store, folders), store);
  assert.deepEqual(lib.serializeAccountStore(store).removedDirs, ['/r/gone']);
});

// --- API-key accounts ---

test('normalizeAccountStore: keeps the API-key kind, anything else reads as a Claude login', () => {
  const store = lib.normalizeAccountStore({
    accounts: [
      { id: 'key', name: 'Key', configDir: '/k', kind: 'apiKey' },
      { id: 'old', name: 'Old', configDir: '/o' },
      { id: 'odd', name: 'Odd', configDir: '/x', kind: 'weird' },
    ],
  });
  assert.deepEqual(store.accounts.map((a) => a.kind), ['claude', 'apiKey', 'claude', 'claude']);
  assert.deepEqual(lib.normalizeAccountStore(lib.serializeAccountStore(store)), store);
});

test('accountEnv: an API-key account also passes ANTHROPIC_API_KEY, a login account never does', () => {
  assert.deepEqual(lib.accountEnv({ configDir: '/k', kind: 'apiKey' }, 'sk-ant-xyz'),
    { CLAUDE_CONFIG_DIR: '/k', ANTHROPIC_API_KEY: 'sk-ant-xyz' });
  assert.deepEqual(lib.accountEnv({ configDir: '/k', kind: 'apiKey' }, ''), { CLAUDE_CONFIG_DIR: '/k' });
  assert.deepEqual(lib.accountEnv({ configDir: '/w', kind: 'claude' }, 'sk-ant-xyz'), { CLAUDE_CONFIG_DIR: '/w' });
});

test('cleanApiKey / maskApiKey', () => {
  assert.equal(lib.cleanApiKey('  sk-ant-api03-abcdefghijklmnop  '), 'sk-ant-api03-abcdefghijklmnop');
  assert.equal(lib.cleanApiKey('short'), '');
  assert.equal(lib.cleanApiKey('sk-ant-api03 abcdefghijklmnop'), '');
  assert.equal(lib.cleanApiKey(null), '');
  assert.equal(lib.maskApiKey('sk-ant-api03-abcdefghijklmnWXYZ'), 'sk-ant-…WXYZ');
  assert.equal(lib.maskApiKey(''), '');
});

test('approveApiKeyInConfig: pre-approves the key suffix once, keeps other settings and approvals', () => {
  const key = 'sk-ant-api03-0123456789abcdefghijKLMNOPQRST';
  const suffix = key.slice(-lib.APPROVED_KEY_SUFFIX_LENGTH);
  const config = lib.approveApiKeyInConfig(
    { theme: 'dark', customApiKeyResponses: { approved: ['other'], rejected: [suffix] } }, key);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.customApiKeyResponses, { approved: ['other', suffix], rejected: [] });
  assert.deepEqual(lib.approveApiKeyInConfig(config, key).customApiKeyResponses.approved, ['other', suffix]);
  assert.deepEqual(lib.approveApiKeyInConfig(null, key).customApiKeyResponses, { approved: [suffix], rejected: [] });
});

test('encodeStoredApiKey / decodeStoredApiKey: encrypted when the OS can, plain otherwise', () => {
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (b) => b.toString().split('').reverse().join(''),
  };
  const stored = lib.encodeStoredApiKey('sk-ant-secret', fakeSafeStorage);
  assert.match(stored, /^enc:/);
  assert.ok(!stored.includes('sk-ant-secret'));
  assert.equal(lib.decodeStoredApiKey(stored, fakeSafeStorage), 'sk-ant-secret');
  const plain = lib.encodeStoredApiKey('sk-ant-secret', { ...fakeSafeStorage, isEncryptionAvailable: () => false });
  assert.equal(plain, 'plain:sk-ant-secret');
  assert.equal(lib.decodeStoredApiKey(plain, null), 'sk-ant-secret');
  assert.equal(lib.decodeStoredApiKey(stored, null), '');
  assert.equal(lib.decodeStoredApiKey('garbage', fakeSafeStorage), '');
  const broken = { ...fakeSafeStorage, decryptString: () => { throw new Error('locked'); } };
  assert.equal(lib.decodeStoredApiKey(stored, broken), '');
});

test('planAccountMove: switching to an API-key account restarts proxied sessions too', () => {
  const sessions = [
    { id: 'proxied', live: true, family: 'claude', accountId: 'a', proxied: true, state: 'idle' },
    { id: 'direct', live: true, family: 'claude', accountId: 'a', proxied: false, state: 'idle' },
    { id: 'proxiedBusy', live: true, family: 'claude', accountId: 'a', proxied: true, state: 'working' },
  ];
  assert.deepEqual(lib.planAccountMove(sessions, 'key', { activeIsApiKey: true }),
    { now: ['proxied', 'direct'], later: ['proxiedBusy'] });
  assert.deepEqual(lib.planAccountMove(sessions, 'b'), { now: ['direct'], later: [] });
  assert.equal(lib.shouldMoveAfterState(sessions[2], 'idle', 'key', { activeIsApiKey: true }), true);
  assert.equal(lib.shouldMoveAfterState(sessions[2], 'idle', 'b'), false);
});

test('recoverAccounts: a lost API-key folder comes back as an API-key account', () => {
  const store = lib.normalizeAccountStore(null);
  const recovered = lib.recoverAccounts(store, [
    { folderName: 'billing', configDir: '/r/billing', signedIn: false, hasApiKey: true, claudeJson: null },
  ]);
  assert.equal(recovered.accounts[1].kind, 'apiKey');
  assert.equal(recovered.accounts[1].configDir, '/r/billing');
});
