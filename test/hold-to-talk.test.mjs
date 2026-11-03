import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPhrase, holdOutcome, HOLD_TARGET, HOLD_TO_TALK_MS, MAX_HOLD_MS } from '../src/renderer/shared/hold-to-talk.js';

test('appendPhrase joins phrases with one space and skips blanks', () => {
  assert.equal(appendPhrase('', 'Open the file'), 'Open the file');
  assert.equal(appendPhrase('Open the file', 'and fix the bug'), 'Open the file and fix the bug');
  assert.equal(appendPhrase('Open the file', '  '), 'Open the file');
  assert.equal(appendPhrase('Open the file', undefined), 'Open the file');
  assert.equal(appendPhrase('', '  Yeni bir pull request oluştur '), 'Yeni bir pull request oluştur');
});

test('holdOutcome: cancel wins, no words means empty, words create a session', () => {
  assert.equal(holdOutcome('fix it', true), 'cancel');
  assert.equal(holdOutcome('', false), 'empty');
  assert.equal(holdOutcome('   ', false), 'empty');
  assert.equal(holdOutcome(undefined, false), 'empty');
  assert.equal(holdOutcome('fix it', false), 'create');
});

test('the hold target can never be mistaken for a session id', () => {
  // Session ids are UUIDs; the sentinel must not look like one.
  assert.doesNotMatch(HOLD_TARGET, /^[0-9a-f-]{36}$/i);
  assert.ok(HOLD_TO_TALK_MS > 0 && HOLD_TO_TALK_MS < 1000, 'a hold threshold a person can feel as a press');
  assert.ok(MAX_HOLD_MS > HOLD_TO_TALK_MS);
});
