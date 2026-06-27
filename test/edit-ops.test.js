const { test } = require('node:test');
const assert = require('node:assert/strict');
const { editOp, replayEdits, commitContent, inverseEdits } = require('../src/main/edit-ops');

test('editOp: maps each file tool to its op shape', () => {
  assert.deepEqual(editOp('Write', { content: 'x' }), { t: 'write', content: 'x' });
  assert.deepEqual(editOp('Write', {}), { t: 'write', content: '' });
  assert.deepEqual(
    editOp('Edit', { old_string: 'a', new_string: 'b', replace_all: true }),
    { t: 'edit', old: 'a', new: 'b', all: true },
  );
  assert.deepEqual(
    editOp('Edit', {}),
    { t: 'edit', old: '', new: '', all: false },
  );
  assert.deepEqual(
    editOp('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }] }),
    { t: 'multi', edits: [{ old: 'a', new: 'b', all: false }] },
  );
  assert.deepEqual(editOp('NotebookEdit', {}), { t: 'opaque' });
  assert.deepEqual(editOp('SomethingElse', {}), { t: 'opaque' });
});

test('replayEdits: a single edit applies onto the base', () => {
  const r = replayEdits('hello world', [{ t: 'edit', old: 'world', new: 'there' }]);
  assert.deepEqual(r, { content: 'hello there', clean: true });
});

test('replayEdits: a write replaces everything regardless of base', () => {
  const r = replayEdits('old contents', [{ t: 'write', content: 'brand new' }]);
  assert.deepEqual(r, { content: 'brand new', clean: true });
});

test('replayEdits: empty old_string appends (insertion)', () => {
  const r = replayEdits('a', [{ t: 'edit', old: '', new: 'b' }]);
  assert.deepEqual(r, { content: 'ab', clean: true });
});

test('replayEdits: replace_all replaces every occurrence; default replaces first', () => {
  assert.equal(replayEdits('a a a', [{ t: 'edit', old: 'a', new: 'b', all: true }]).content, 'b b b');
  assert.equal(replayEdits('a a a', [{ t: 'edit', old: 'a', new: 'b', all: false }]).content, 'b a a');
});

test('replayEdits: missing old_string marks unclean but keeps going', () => {
  const r = replayEdits('hello', [{ t: 'edit', old: 'absent', new: 'x' }]);
  assert.equal(r.clean, false);
  assert.equal(r.content, 'hello');
});

test('replayEdits: an opaque op marks the whole replay unclean', () => {
  const r = replayEdits('hello', [{ t: 'opaque' }]);
  assert.equal(r.clean, false);
});

test('replayEdits: multi applies its edits in order', () => {
  const r = replayEdits('1 2 3', [{ t: 'multi', edits: [
    { old: '1', new: 'one' },
    { old: '2', new: 'two' },
  ] }]);
  assert.deepEqual(r, { content: 'one two 3', clean: true });
});

test('commitContent: a clean replay that changes the file is committed', () => {
  const r = commitContent('hello world', [{ t: 'edit', old: 'world', new: 'there' }], 'ignored');
  assert.equal(r, 'hello there');
});

test('commitContent: an edit that nets back to HEAD is an empty patch (null)', () => {
  // Session changed "a"->"b" then "b"->"a": the result equals HEAD, so committing
  // it would produce no diff. It must be dropped, not committed as a no-op blob.
  const r = commitContent('value a', [
    { t: 'edit', old: 'a', new: 'b' },
    { t: 'edit', old: 'b', new: 'a' },
  ], 'whatever');
  assert.equal(r, null);
});

test('commitContent: a Write of the identical content is an empty patch (null)', () => {
  const r = commitContent('same', [{ t: 'write', content: 'same' }], 'same');
  assert.equal(r, null);
});

test('commitContent: an unclean replay falls back to the working file', () => {
  // old_string is gone from HEAD (another session moved it), so the replay is
  // unclean — we commit the current working contents instead.
  const r = commitContent('moved text', [{ t: 'edit', old: 'absent', new: 'x' }], 'working now');
  assert.equal(r, 'working now');
});

test('commitContent: unclean fallback equal to HEAD is still an empty patch', () => {
  const r = commitContent('base', [{ t: 'opaque' }], 'base');
  assert.equal(r, null);
});

test('commitContent: a missing working file (gone) returns null', () => {
  const r = commitContent('base', [{ t: 'opaque' }], null);
  assert.equal(r, null);
});

test('inverseEdits: backs out an edit (new -> old)', () => {
  const r = inverseEdits('hello there', [{ t: 'edit', old: 'world', new: 'there' }]);
  assert.deepEqual(r, { content: 'hello world', clean: true });
});

test('inverseEdits: a write cannot be inverted (no pre-image)', () => {
  const r = inverseEdits('whatever', [{ t: 'write', content: 'whatever' }]);
  assert.equal(r.clean, false);
});

test('inverseEdits: pure deletion (empty new) cannot be relocated', () => {
  const r = inverseEdits('current', [{ t: 'edit', old: 'gone', new: '' }]);
  assert.equal(r.clean, false);
});

test('inverseEdits: new_string already overwritten -> unclean', () => {
  const r = inverseEdits('something else', [{ t: 'edit', old: 'a', new: 'b' }]);
  assert.equal(r.clean, false);
});

test('replay then inverse round-trips back to the base', () => {
  const base = 'function f() { return 1; }';
  const ops = [
    { t: 'edit', old: 'return 1', new: 'return 2' },
    { t: 'edit', old: 'f()', new: 'g()' },
  ];
  const replayed = replayEdits(base, ops);
  assert.equal(replayed.clean, true);
  const inverted = inverseEdits(replayed.content, ops);
  assert.deepEqual(inverted, { content: base, clean: true });
});

test('inverse leaves another region untouched (the cross-session guarantee)', () => {
  // Our session changed "foo"->"FOO"; another session independently changed
  // "bar"->"BAR" in the same file. Inverting only our op must keep BAR.
  const working = 'FOO and BAR';
  const ours = [{ t: 'edit', old: 'foo', new: 'FOO' }];
  const r = inverseEdits(working, ours);
  assert.deepEqual(r, { content: 'foo and BAR', clean: true });
});
