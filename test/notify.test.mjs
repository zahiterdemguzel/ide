import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompletionTransition, SOUNDS } from '../src/renderer/shared/notify.js';

test('fires only on working → completed', () => {
  assert.equal(isCompletionTransition('working', 'completed'), true);
});

test('does not fire on other transitions into completed', () => {
  assert.equal(isCompletionTransition('idle', 'completed'), false);
  assert.equal(isCompletionTransition('needs-input', 'completed'), false);
  assert.equal(isCompletionTransition(undefined, 'completed'), false);
});

test('does not fire when working moves to a non-completed state', () => {
  assert.equal(isCompletionTransition('working', 'needs-input'), false);
  assert.equal(isCompletionTransition('working', 'pushed'), false);
  assert.equal(isCompletionTransition('working', 'working'), false);
});

test('every sound has a unique id and a name; audible sounds have well-formed notes', () => {
  const ids = SOUNDS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'sound ids are unique');
  for (const s of SOUNDS) {
    assert.ok(s.name, `${s.id} has a name`);
    assert.ok(Array.isArray(s.notes), `${s.id} has a notes array`);
    for (const n of s.notes) {
      assert.ok(n.f > 0 && n.d > 0 && n.g > 0, `${s.id} note is well-formed`);
    }
  }
});

test('"None" is a silent sentinel with no notes', () => {
  const none = SOUNDS.find((s) => s.id === 'none');
  assert.ok(none, 'a "none" sound exists');
  assert.equal(none.notes.length, 0, '"none" schedules no tones');
});

test('every audible sound has at least one note', () => {
  for (const s of SOUNDS.filter((x) => x.id !== 'none')) {
    assert.ok(s.notes.length >= 1, `${s.id} has notes`);
  }
});
