const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_PERSIST_BYTES, serializeSession, deserializeSession, sessionBytes, enforceLimit } = require('../src/main/session-persist');

// A live in-memory session entry the way sessions.js holds it.
function liveSession({ firstPrompt = '', name = '', archived = false, edits = [], fileOps = [] } = {}) {
  return { pty: {}, preStatus: { junk: 1 }, suspended: archived, archived, firstPrompt, name, edits: new Map(edits), fileOps: new Map(fileOps) };
}

test('serializeSession: drops runtime-only fields and flattens the Maps', () => {
  const s = liveSession({
    firstPrompt: 'fix the bug', name: 'Bug fix', archived: true,
    edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]],
    fileOps: [['/r/bin.png', 'add']],
  });
  const out = serializeSession('id-1', s);
  assert.deepEqual(out, {
    id: 'id-1',
    firstPrompt: 'fix the bug',
    name: 'Bug fix',
    archived: true,
    edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]],
    fileOps: [['/r/bin.png', 'add']],
  });
  assert.equal('pty' in out, false);
  assert.equal('preStatus' in out, false);
});

test('serialize -> deserialize round-trips the tracked-file state, minus the PTY', () => {
  const s = liveSession({
    firstPrompt: 'p', name: 'n', archived: false,
    edits: [['/r/a.js', [{ t: 'edit', old: 'a', new: 'b' }]]],
    fileOps: [['/r/x', 'delete']],
  });
  const restored = deserializeSession(serializeSession('id', s));
  assert.equal(restored.pty, null);
  assert.equal(restored.suspended, true);            // no live process after a restart
  assert.equal(restored.archived, false);
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
