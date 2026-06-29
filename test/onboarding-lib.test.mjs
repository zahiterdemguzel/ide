import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_STEPS, placeBubble } from '../src/renderer/shared/onboarding-lib.js';

const VIEWPORT = { width: 1000, height: 800 };
const BUBBLE = { width: 200, height: 80 };

test('placeBubble: sits above the anchor when there is room, tail pointing down', () => {
  const anchor = { top: 400, left: 450, width: 100, height: 30, bottom: 430 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  assert.equal(p.placement, 'top');
  assert.equal(p.below, false);
  assert.equal(p.top, 400 - 80 - 10); // above with the 10px margin
  assert.equal(p.left, 500 - 100); // centred on the anchor centre (500)
});

test('placeBubble: flips below when the anchor is too close to the top', () => {
  const anchor = { top: 5, left: 450, width: 100, height: 30, bottom: 35 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  assert.equal(p.placement, 'bottom');
  assert.equal(p.below, true);
  assert.equal(p.top, 35 + 10); // below the anchor bottom + margin
});

test('placeBubble: a tall target lands to the LEFT, vertically centred, when neither above nor below fits', () => {
  // A full-height region like the session terminal: no room above or below.
  const anchor = { top: 40, left: 400, width: 300, height: 720, bottom: 760 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  assert.equal(p.placement, 'left');
  assert.equal(p.below, false);
  assert.equal(p.left, 400 - BUBBLE.width - 10); // bubble sits left of the target
  // centred on the target centre (cy = 400), clamped within the viewport
  assert.equal(p.top, 400 - BUBBLE.height / 2);
  // vertical tail offset points back at the target centre
  assert.equal(p.tail, 400 - p.top);
});

test('placeBubble: a tall target hugging the left edge lands to the RIGHT instead', () => {
  const anchor = { top: 40, left: 8, width: 300, height: 720, bottom: 760 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  assert.equal(p.placement, 'right');
  assert.equal(p.left, 8 + 300 + 10); // bubble sits right of the target
});

test('placeBubble: clamps to the viewport for an anchor near the right edge', () => {
  const anchor = { top: 400, left: 980, width: 20, height: 20, bottom: 420 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  // left clamped so the bubble stays fully on screen (viewport - width - margin)
  assert.equal(p.left, VIEWPORT.width - BUBBLE.width - 10);
  // anchor centre (990) lands at the bubble's right edge, so the tail clamps to
  // its max inset (width - 14) rather than spilling past the bubble
  assert.equal(p.tail, BUBBLE.width - 14);
});

test('placeBubble: tail stays within the bubble for an off-centre clamp', () => {
  const anchor = { top: 400, left: 0, width: 10, height: 10, bottom: 410 };
  const p = placeBubble(anchor, BUBBLE, VIEWPORT);
  assert.ok(p.tail >= 14 && p.tail <= BUBBLE.width - 14);
});

test('TOUR_STEPS is well-formed: unique ids and required i18n keys', () => {
  const ids = TOUR_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  for (const step of TOUR_STEPS) {
    assert.ok(step.target, 'each step needs a target');
    assert.ok(step.titleKey && step.bodyKey, 'each step needs a titleKey and bodyKey');
  }
});
