import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTypingDelay, promptSubmitDelay, TUI_READY_MS } from '../src/renderer/shared/prompt-timing.js';

test('promptTypingDelay waits for first output, then the rest of the TUI start-up', () => {
  assert.equal(promptTypingDelay(undefined, 5000), null, 'no output yet: wait for it');
  assert.equal(promptTypingDelay(5000, 5000), TUI_READY_MS, 'just printed: the full second');
  assert.equal(promptTypingDelay(5000, 5600), TUI_READY_MS - 600);
  assert.equal(promptTypingDelay(5000, 5000 + TUI_READY_MS), 0);
  assert.equal(promptTypingDelay(5000, 9000), 0, 'up for a while (a background voice session): type now');
});

test('promptSubmitDelay grows with the text and is capped', () => {
  assert.equal(promptSubmitDelay(''), 400);
  assert.equal(promptSubmitDelay(undefined), 400);
  assert.equal(promptSubmitDelay('x'.repeat(400)), 500);
  assert.equal(promptSubmitDelay('x'.repeat(100000)), 3000);
});
