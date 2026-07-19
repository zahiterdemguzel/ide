const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_PERSIST_BYTES, persistedState, serializeSession, deserializeSession, isSessionPersistable, sessionBytes, enforceLimit } = require('../src/main/session-persist');
const { DEFAULT_EFFORT } = require('../src/main/agent-effort');

// A live in-memory session entry the way sessions.js holds it.
function liveSession({ repo = '', firstPrompt = '', name = '', archived = false, state = 'completed', model = '', subagentModel = '', effort = '', transcript = '', startedAt = 0, lastActiveAt = 0, tool = null, edits = [], fileOps = [] } = {}) {
  return { pty: {}, preStatus: { junk: 1 }, suspended: archived, archived, repo, firstPrompt, name, state, model, subagentModel, effort, transcript, startedAt, lastActiveAt, tool, edits: new Map(edits), fileOps: new Map(fileOps) };
}

test('serializeSession: drops runtime-only fields and flattens the Maps', () => {
  const s = liveSession({
    repo: '/projects/app', firstPrompt: 'fix the bug', name: 'Bug fix', archived: true, state: 'completed',
    model: 'opus', subagentModel: 'haiku', effort: 'high', transcript: '/home/u/.claude/projects/app/id-1.jsonl',
    startedAt: 1000, lastActiveAt: 2000, tool: { name: 'Edit', file: 'a.js' },
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
    model: 'opus',
    subagentModel: 'haiku',
    effort: 'high',
    // The session id the agent CLI itself uses — set only for Codex sessions,
    // whose CLI invents its own id (it's what `codex resume` needs).
    agentSessionId: '',
    // Where Claude keeps this session's conversation — the phone renders it as a chat,
    // and no hook fires for an archived session to name the file again.
    transcript: '/home/u/.claude/projects/app/id-1.jsonl',
    startedAt: 1000,
    lastActiveAt: 2000,
    edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]],
    fileOps: [['/r/bin.png', 'add']],
  });
  assert.equal('pty' in out, false);
  assert.equal('preStatus' in out, false);
  // The in-flight tool is runtime-only: a restored session runs nothing.
  assert.equal('tool' in out, false);
});

test('serialize -> deserialize keeps the timestamps and forgets the tool', () => {
  const s = liveSession({ startedAt: 1700000000000, lastActiveAt: 1700000060000, tool: { name: 'Edit', file: 'a.js' } });
  const restored = deserializeSession(serializeSession('id', s));
  assert.equal(restored.startedAt, 1700000000000);
  assert.equal(restored.lastActiveAt, 1700000060000);
  assert.equal(restored.tool, null);
});

test('deserializeSession: a snapshot predating the timestamps reopens with 0, not 1970', () => {
  // 0 is the "unknown" the row reads as "show no time".
  const restored = deserializeSession({ id: 'x', repo: '/r', state: 'idle' });
  assert.equal(restored.startedAt, 0);
  assert.equal(restored.lastActiveAt, 0);
});

test('persistedState: only an actively-running session reopens interrupted', () => {
  assert.equal(persistedState('completed'), 'completed'); // finished agent stays green
  assert.equal(persistedState('pushed'), 'pushed');       // committed work stays purple
  assert.equal(persistedState('idle'), 'idle');           // untouched session stays gray
  assert.equal(persistedState('working'), 'interrupted'); // only actively-running work reopens red
  assert.equal(persistedState('needs-input'), 'completed'); // paused-for-input reads green, not red
  assert.equal(persistedState(undefined), 'idle');        // a pre-state snapshot
});

test('serializeSession: an in-flight session is persisted as interrupted', () => {
  assert.equal(serializeSession('id', liveSession({ state: 'working' })).state, 'interrupted');
  assert.equal(serializeSession('id', liveSession({ state: 'needs-input' })).state, 'completed');
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

test('serialize -> deserialize round-trips the per-session model and effort choice', () => {
  const restored = deserializeSession(serializeSession('id', liveSession({ model: 'sonnet', subagentModel: 'haiku', effort: 'xhigh' })));
  assert.equal(restored.model, 'sonnet');
  assert.equal(restored.subagentModel, 'haiku');
  // Effort is a spawn flag, so this is what makes a resumed session think as hard as it
  // was last told to (sessions.js re-applies it via `--effort` on every spawn).
  assert.equal(restored.effort, 'xhigh');
  // A snapshot predating the feature inherits everything it can — but not the effort:
  // that resolves to a real level, since a session whose level the badge can't name is
  // exactly what this normalization exists to prevent.
  const old = deserializeSession({ id: 'x' });
  assert.equal(old.model, '');
  assert.equal(old.subagentModel, '');
  assert.equal(old.effort, DEFAULT_EFFORT);
});

test('a snapshot written when auto was a level resolves to a real one', () => {
  // `auto` meant "no flag, let the CLI decide" — a level the badge could not state.
  // Normalizing on load is what makes the badge's answer true, at the cost of such a
  // session resuming at a stated level rather than the CLI's unstated one.
  assert.equal(deserializeSession({ id: 'x', effort: 'auto' }).effort, DEFAULT_EFFORT);
  // A codex session carrying claude's `max` can't spawn with it — clamped to the shared
  // fallback rather than left to fail.
  assert.equal(deserializeSession({ id: 'x', model: 'codex:gpt-5.4', effort: 'max' }).effort, DEFAULT_EFFORT);
  // A level the family does have is left exactly as it was.
  assert.equal(deserializeSession({ id: 'x', model: 'codex:gpt-5.4', effort: 'high' }).effort, 'high');
  assert.equal(deserializeSession({ id: 'x', model: 'sonnet', effort: 'max' }).effort, 'max');
});

test('deserializeSession: tolerates a malformed snapshot', () => {
  const restored = deserializeSession({ id: 'x' });
  assert.equal(restored.edits.size, 0);
  assert.equal(restored.fileOps.size, 0);
  assert.equal(restored.suspended, true);
  assert.equal(restored.state, 'idle');
});

test('isSessionPersistable: an empty husk (no conversation, no work) is not saved', () => {
  // Created but never prompted — resuming it would fail with "No conversation found".
  assert.equal(isSessionPersistable(liveSession()), false);
  assert.equal(isSessionPersistable(liveSession({ name: 'Untitled', state: 'idle' })), false);
  assert.equal(isSessionPersistable(undefined), false);
});

test('isSessionPersistable: a session with a conversation or tracked work is saved', () => {
  assert.equal(isSessionPersistable(liveSession({ firstPrompt: 'fix the bug' })), true);
  assert.equal(isSessionPersistable(liveSession({ edits: [['/r/a.js', [{ t: 'write', content: 'x' }]]] })), true);
  assert.equal(isSessionPersistable(liveSession({ fileOps: [['/r/bin.png', 'add']] })), true);
  // Also accepts a raw snapshot whose edits/fileOps are still arrays.
  assert.equal(isSessionPersistable({ firstPrompt: 'p' }), true);
  assert.equal(isSessionPersistable({ edits: [['/r/a', []]], fileOps: [] }), true);
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
