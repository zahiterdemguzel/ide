const test = require('node:test');
const assert = require('node:assert');
const { hashContent, looksBinary, deriveOp, MAX_HUNK_BYTES } = require('../src/main/fs-content');
const { replayEdits, inverseEdits, diffStat } = require('../src/main/edit-ops');

// A derived op is only useful if replaying it onto the pre-image reproduces the
// post-image exactly — that round trip is what the per-session commit relies on.
function roundTrip(before, after) {
  const op = deriveOp(before, after);
  assert.ok(op, 'expected an op');
  const r = replayEdits(before, [op]);
  assert.ok(r.clean, 'replay was not clean');
  assert.strictEqual(r.content, after);
  return op;
}

test('hashContent distinguishes same-size content', () => {
  // The case the old size+mtime stamp could not see: `sed -i 's/foo/bar/'`.
  assert.notStrictEqual(hashContent(Buffer.from('foo')), hashContent(Buffer.from('bar')));
  assert.strictEqual(hashContent(Buffer.from('foo')), hashContent(Buffer.from('foo')));
});

test('looksBinary flags NUL bytes only', () => {
  assert.strictEqual(looksBinary(Buffer.from('plain text\n')), false);
  assert.strictEqual(looksBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01])), true);
  // A NUL past the sniff window is not looked at, same as git.
  assert.strictEqual(looksBinary(Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])), false);
});

test('identical content derives no op', () => {
  assert.strictEqual(deriveOp('same\n', 'same\n'), null);
});

test('a new file derives a write', () => {
  assert.deepStrictEqual(deriveOp('', 'hello\n'), { t: 'write', content: 'hello\n' });
});

test('a one-line substitution derives a minimal edit', () => {
  const before = 'alpha\nbeta\ngamma\n';
  const op = roundTrip(before, 'alpha\nBETA\ngamma\n');
  assert.strictEqual(op.t, 'edit');
  assert.strictEqual(op.old, 'beta');
  assert.strictEqual(op.new, 'BETA');
});

test('a derived edit replays onto a DIFFERENT base — the whole point', () => {
  // Another session (or the user) changed an unrelated line in the same file.
  // The session's own hunk must still land, and their line must survive.
  const before = 'alpha\nbeta\ngamma\n';
  const op = deriveOp(before, 'alpha\nBETA\ngamma\n');
  const head = 'ALPHA\nbeta\ngamma\n';
  const r = replayEdits(head, [op]);
  assert.ok(r.clean);
  assert.strictEqual(r.content, 'ALPHA\nBETA\ngamma\n');
});

test('a derived edit inverts, so the change can be backed out alone', () => {
  const before = 'alpha\nbeta\ngamma\n';
  const after = 'alpha\nBETA\ngamma\n';
  const op = deriveOp(before, after);
  const r = inverseEdits(after, [op]);
  assert.ok(r.clean);
  assert.strictEqual(r.content, before);
});

test('a derived edit carries line counts for the session pill', () => {
  const op = deriveOp('a\nb\nc\n', 'a\nb2\nb3\nc\n');
  assert.deepStrictEqual(diffStat([op]), { added: 2, removed: 1 });
});

test('a mid-file insertion grows context instead of appending', () => {
  // The trimmed hunk here is empty (only added lines); emitting it as-is would
  // make replayEdits append to the END of the file.
  const op = roundTrip('one\ntwo\nthree\n', 'one\ntwo\nINSERTED\nthree\n');
  assert.strictEqual(op.t, 'edit');
  assert.ok(op.old.length > 0);
});

test('a deletion at the head of the file round-trips', () => {
  roundTrip('one\ntwo\nthree\n', 'two\nthree\n');
});

test('an append round-trips', () => {
  roundTrip('one\ntwo\n', 'one\ntwo\nthree\n');
});

test('a repeated line grows context until the hunk is unique', () => {
  const before = 'x\nsame\nx\nsame\nx\n';
  const after = 'x\nsame\nx\nCHANGED\nx\n';
  const op = roundTrip(before, after);
  assert.strictEqual(op.t, 'edit');
  // "same" alone appears twice, so the hunk must have grown past it.
  assert.ok(op.old.split('\n').length > 1);
});

test('an all-identical-lines file still round-trips', () => {
  // Nothing short of (nearly) the whole file is unique here. The expansion loop
  // must terminate with something replayable rather than scan forever.
  roundTrip('a\n'.repeat(50), 'a\n'.repeat(49) + 'b\n');
});

test('a wholesale rewrite round-trips', () => {
  roundTrip('alpha\nbeta\n', 'totally\ndifferent\n');
});

test('emptying a file round-trips', () => {
  roundTrip('alpha\nbeta\n', '');
});

test('an oversized hunk falls back to a write', () => {
  const filler = 'keep\n';
  const big = 'x'.repeat(MAX_HUNK_BYTES + 10);
  const op = deriveOp(filler + 'old\n', filler + big + '\n');
  assert.strictEqual(op.t, 'write');
});

test('files without trailing newlines round-trip', () => {
  roundTrip('alpha\nbeta', 'alpha\ngamma');
});

test('CRLF content round-trips', () => {
  roundTrip('alpha\r\nbeta\r\n', 'alpha\r\nBETA\r\n');
});
