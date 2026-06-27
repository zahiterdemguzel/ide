const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_PERSIST_BYTES, persistedState, serializeSession, deserializeSession, sessionBytes, enforceLimit } = require('../src/main/session-persist');

// A live in-memory session entry the way sessions.js holds it.
function liveSession({ repo = '', firstPrompt = '', name = '', archived = false, state = 'completed', edits = [], fileOps = [] } = {}) {
  return { pty: {}, preStatus: { junk: 1 }, suspended: archived, archived, repo, firstPrompt, name, state, edits: new Map(edits), fileOps: new Map(fileOps) };
}

test('serializeSession: drops runtime-only fields and flattens the Maps', () => {
  const s = liveSession({
    repo: '/projects/app', firstPrompt: 'fix the bug', name: 'Bug fix', archived: true, state: 'completed',
    edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]],
    fileOps: [['/r/bin.png', 'add']],
  });
  const out = serializeSession('id-1', s);
  assert.deepEqual(out, {
    id: 'id-1',
    repo: '/projects/app',
    firstPrompt: 'fix the bug',
    name: 'Bug fix',
    archived: true,
    state: 'completed',
    edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]],
    fileOps: [['/r/bin.png', 'add']],
  });
  assert.equal('pty' in out, false);
  assert.equal('preStatus' in out, false);
});

test('persistedState: only an actively-running session reopens interrupted', () => {
  assert.equal(persistedState('completed'), 'completed'); // finished agent stays green
  assert.equal(persistedState('pushed'), 'pushed');       // committed work stays purple
  assert.equal(persistedState('idle'), 'idle');           // untouched session stays gray
  assert.equal(persistedState('working'), 'interrupted');
  assert.equal(persistedState('needs-input'), 'interrupted');
  assert.equal(persistedState(undefined), 'idle');        // a pre-state snapshot
});

test('serializeSession: an in-flight session is persisted as interrupted', () => {
  assert.equal(serializeSession('id', liveSession({ state: 'working' })).state, 'interrupted');
  assert.equal(serializeSession('id', liveSession({ state: 'pushed' })).state, 'pushed');
});

test('serialize -> deserialize round-trips the tracked-file state, minus the PTY', () => {
  const s = liveSession({
    repo: '/projects/app', firstPrompt: 'p', name: 'n', archived: false, state: 'pushed',
    edits: [['/r/a.js', [{ t: 'edit', old: 'a', new: 'b' }]]],
    fileOps: [['/r/x', 'delete']],
  });
  const restored = deserializeSession(serializeSession('id', s));
  assert.equal(restored.pty, null);
  assert.equal(restored.suspended, true);            // no live process after a restart
  assert.equal(restored.archived, false);
  assert.equal(restored.state, 'pushed');            // committed work reopens purple
  assert.equal(restored.repo, '/projects/app');      // session stays bound to its project
  assert.equal(restored.firstPrompt, 'p');
  assert.equal(restored.name, 'n');
  assert.deepEqual([...restored.edits.entries()], [['/r/a.js', [{ t: 'edit', old: 'a', new: 'b' }]]]);
  assert.deepEqual([...restored.fileOps.entries()], [['/r/x', 'delete']]);
});

test('deserializeSession: tolerates a malformed snapshot', () => {
  const restored = deserializeSession({ id: 'x' });
  assert.equal(restored.edits.size, 0);
  assert.equal(restored.fileOps.size, 0);
  assert.equal(restored.suspended, true);
  assert.equal(restored.state, 'idle');
});

test('sessionBytes: grows with the tracked content', () => {
  const small = sessionBytes(serializeSession('a', liveSession()));
  const big = sessionBytes(serializeSession('a', liveSession({ edits: [['/r/a', [{ t: 'write', content: 'x'.repeat(1000) }]]] })));
  assert.ok(big > small + 900);
});

test('enforceLimit: evicts the oldest sessions first until under budget', () => {
  const entries = [
    { id: 'old', bytes: 60, evictable: true },
    { id: 'mid', bytes: 60, evictable: true },
    { id: 'new', bytes: 60, evictable: true },
  ];
  const { evictedIds, totalBytes } = enforceLimit(entries, 130);
  assert.deepEqual(evictedIds, ['old']); // 180 -> drop oldest -> 120 <= 130
  assert.equal(totalBytes, 120);
});

test('enforceLimit: never evicts a running (non-evictable) session', () => {
  const entries = [
    { id: 'running-old', bytes: 100, evictable: false },
    { id: 'archived-mid', bytes: 100, evictable: true },
    { id: 'archived-new', bytes: 100, evictable: true },
  ];
  // 300 over 150: skip the running one, evict the oldest evictable sessions until
  // it fits (both archived ones go; the running session is left running).
  const { evictedIds, totalBytes } = enforceLimit(entries, 150);
  assert.deepEqual(evictedIds, ['archived-mid', 'archived-new']);
  assert.equal(totalBytes, 100); // only the running session remains
});

test('enforceLimit: evicts all it can even when the un-evictable ones alone exceed budget', () => {
  const entries = [
    { id: 'running-a', bytes: 200, evictable: false },
    { id: 'archived', bytes: 50, evictable: true },
  ];
  const { evictedIds } = enforceLimit(entries, 100);
  assert.deepEqual(evictedIds, ['archived']); // can't get under 100, but frees what it can
});

test('enforceLimit: nothing to do when already under budget', () => {
  const entries = [{ id: 'a', bytes: 10, evictable: true }];
  assert.deepEqual(enforceLimit(entries, 1000).evictedIds, []);
});

test('the budget is 100 MB', () => {
  assert.equal(MAX_PERSIST_BYTES, 100 * 1024 * 1024);
});
