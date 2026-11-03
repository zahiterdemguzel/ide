// The Control tab's frame-area resize classification (mobile/src/lib/frame-layout.js):
// a keyboard opening must not reset zoom or re-open the desktop capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLayoutChange } from '../mobile/src/lib/frame-layout.js';

test('the first layout is always a resize', () => {
  assert.equal(classifyLayoutChange(null, { w: 390, h: 600 }, false), 'resize');
  assert.equal(classifyLayoutChange({ w: 0, h: 0 }, { w: 390, h: 600 }, false), 'resize');
});

test('sub-epsilon jitter is no change', () => {
  assert.equal(classifyLayoutChange({ w: 390, h: 600 }, { w: 391, h: 599 }, false), 'none');
});

test('a height-only change while the keyboard is up is transient', () => {
  assert.equal(classifyLayoutChange({ w: 390, h: 600 }, { w: 390, h: 320 }, true), 'keyboard');
});

test('the same change without a keyboard is a real resize', () => {
  assert.equal(classifyLayoutChange({ w: 390, h: 600 }, { w: 390, h: 320 }, false), 'resize');
});

test('a width change (rotation) is a resize even with the keyboard up', () => {
  assert.equal(classifyLayoutChange({ w: 390, h: 600 }, { w: 800, h: 300 }, true), 'resize');
});
