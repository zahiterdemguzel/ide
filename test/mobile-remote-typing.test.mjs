// The phone's soft-keyboard → remote keystroke diff (mobile/src/lib/remote-typing.js),
// used by the Browser and Control tabs' hidden inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedEdits, settleBuffer, BUFFER_SEED, SENTINEL } from '../mobile/src/lib/remote-typing.js';

const S = BUFFER_SEED;

test('a typed character is one text edit', () => {
  assert.deepEqual(typedEdits(S, `${S}a`), [{ kind: 'text', text: 'a' }]);
});

test('a committed word (keyboards that skip onKeyPress) types the whole word once', () => {
  assert.deepEqual(typedEdits(`${S}he`, `${S}hello `), [{ kind: 'text', text: 'llo ' }]);
});

test('backspace on an "empty" field deletes a sentinel and still sends a backspace', () => {
  assert.deepEqual(typedEdits(S, S.slice(1)), [{ kind: 'backspace' }]);
});

test('an autocorrect replacement is backspaces then the new text', () => {
  assert.deepEqual(typedEdits(`${S}teh`, `${S}the`), [
    { kind: 'backspace' }, { kind: 'backspace' }, { kind: 'text', text: 'he' },
  ]);
});

test("iOS's double-space period is mirrored as an edit, not lost", () => {
  assert.deepEqual(typedEdits(`${S}hi `, `${S}hi. `), [{ kind: 'backspace' }, { kind: 'text', text: '. ' }]);
});

test('a newline becomes Enter, with text on either side kept in order', () => {
  assert.deepEqual(typedEdits(S, `${S}a\nb`), [
    { kind: 'text', text: 'a' }, { kind: 'enter' }, { kind: 'text', text: 'b' },
  ]);
  assert.deepEqual(typedEdits(S, `${S}\n`), [{ kind: 'enter' }]);
});

test('an emoji counts as one backspace and is never split', () => {
  assert.deepEqual(typedEdits(`${S}😀`, S), [{ kind: 'backspace' }]);
  assert.deepEqual(typedEdits(`${S}😀`, `${S}😃`), [{ kind: 'backspace' }, { kind: 'text', text: '😃' }]);
});

test('no change, no edits; re-inserted sentinels are never typed', () => {
  assert.deepEqual(typedEdits(`${S}x`, `${S}x`), []);
  assert.deepEqual(typedEdits('', `${SENTINEL}${SENTINEL}`), []);
});

test('settleBuffer keeps a healthy buffer and reseeds one that ran dry, took a newline or grew long', () => {
  assert.equal(settleBuffer(`${S}abc`), `${S}abc`);
  assert.equal(settleBuffer(S.slice(1)), S);
  assert.equal(settleBuffer(`${S}a\n`), S);
  assert.equal(settleBuffer(`${S}${'a'.repeat(60)}`), `${S}${'a'.repeat(60)}`, 'mid-word: left alone');
  assert.equal(settleBuffer(`${S}${'a'.repeat(60)} `), S, 'word boundary past the soft cap: reset');
  assert.equal(settleBuffer(`${S}${'a'.repeat(300)}`), S, 'hard cap: reset regardless');
});
