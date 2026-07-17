const { test } = require('node:test');
const assert = require('node:assert');
const {
  clampCaptureSize, clampFps, clampQuality, keyCandidates, normalizeMods,
  toControlOps, normalizeCursor, clampRegion, regionSourceSize, cropRect,
  MIN_CAP, MAX_CAP, DEFAULT_FPS, DEFAULT_QUALITY, MAX_TEXT,
} = require('../src/main/remote-control-lib');

const W = 2560; const H = 1600;

test('clampCaptureSize bounds and defaults garbage', () => {
  assert.deepEqual(clampCaptureSize({ width: 480, height: 300 }), { width: 480, height: 300 });
  assert.deepEqual(clampCaptureSize({ width: 9999, height: -5 }), { width: MAX_CAP, height: MIN_CAP });
  assert.deepEqual(clampCaptureSize(null), { width: MIN_CAP, height: MIN_CAP });
  assert.deepEqual(clampCaptureSize({ width: 'x', height: NaN }), { width: MIN_CAP, height: MIN_CAP });
});

test('clampFps and clampQuality clamp and default', () => {
  assert.equal(clampFps(3), 3);
  assert.equal(clampFps(100), 10);
  assert.equal(clampFps(undefined), DEFAULT_FPS);
  assert.equal(clampQuality(55), 55);
  assert.equal(clampQuality(5), 20);
  assert.equal(clampQuality('nope'), DEFAULT_QUALITY);
});

test('keyCandidates knows nav keys, letters, digits, F-keys, modifiers', () => {
  assert.deepEqual(keyCandidates('up'), ['Up']);
  assert.deepEqual(keyCandidates('Enter'), ['Enter', 'Return']);
  assert.deepEqual(keyCandidates('meta'), ['LeftSuper', 'LeftWin', 'LeftCmd']);
  assert.deepEqual(keyCandidates('a'), ['A']);
  assert.deepEqual(keyCandidates('7'), ['Num7', 'Digit7']);
  assert.deepEqual(keyCandidates('f5'), ['F5']);
  assert.equal(keyCandidates('nonsense'), null);
  assert.equal(keyCandidates(42), null);
});

test('normalizeMods keeps canonical order and drops unknowns', () => {
  assert.deepEqual(normalizeMods(['shift', 'CTRL', 'bogus']), ['ctrl', 'shift']);
  assert.deepEqual(normalizeMods(['meta']), ['meta']);
  assert.deepEqual(normalizeMods('ctrl'), []);
  assert.deepEqual(normalizeMods(null), []);
});

test('move maps normalized coords to clamped screen px', () => {
  assert.deepEqual(toControlOps({ k: 'move', x: 0.5, y: 0.5 }, W, H), [{ op: 'move', x: 1280, y: 800 }]);
  // 1.0 lands on the last pixel, not one past it
  assert.deepEqual(toControlOps({ k: 'move', x: 1, y: 1 }, W, H), [{ op: 'move', x: W - 1, y: H - 1 }]);
  assert.deepEqual(toControlOps({ k: 'move', x: 1.2, y: 0.5 }, W, H), []);
  assert.deepEqual(toControlOps({ k: 'move', x: NaN, y: 0 }, W, H), []);
});

test('tap moves then clicks; honours button, double and mods', () => {
  assert.deepEqual(toControlOps({ k: 'tap', x: 0, y: 0 }, W, H), [
    { op: 'move', x: 0, y: 0 },
    { op: 'click', button: 'left', count: 1, mods: [] },
  ]);
  const ops = toControlOps({ k: 'tap', x: 0.5, y: 0.5, button: 'right', double: true, mods: ['ctrl'] }, W, H);
  assert.deepEqual(ops[1], { op: 'click', button: 'right', count: 2, mods: ['ctrl'] });
  // unknown button falls back to left rather than being dropped
  assert.equal(toControlOps({ k: 'tap', x: 0.5, y: 0.5, button: 'x1' }, W, H)[1].button, 'left');
});

test('down/up press and release, with optional move', () => {
  assert.deepEqual(toControlOps({ k: 'down', x: 0.25, y: 0.25 }, W, H), [
    { op: 'move', x: 640, y: 400 },
    { op: 'button-down', button: 'left' },
  ]);
  assert.deepEqual(toControlOps({ k: 'up' }, W, H), [{ op: 'button-up', button: 'left' }]);
});

test('scroll rounds deltas and drops empty or malformed scrolls', () => {
  assert.deepEqual(toControlOps({ k: 'scroll', dx: 0, dy: -12.6 }, W, H), [{ op: 'scroll', dx: 0, dy: -13 }]);
  assert.deepEqual(toControlOps({ k: 'scroll', dx: 0, dy: 0 }, W, H), []);
  assert.deepEqual(toControlOps({ k: 'scroll', dx: 'x', dy: 3 }, W, H), []);
});

test('key becomes a combo of mods then key; unknown key drops', () => {
  assert.deepEqual(toControlOps({ k: 'key', key: 'Up' }, W, H), [{ op: 'combo', keys: ['up'] }]);
  assert.deepEqual(toControlOps({ k: 'key', key: 'c', mods: ['meta', 'shift'] }, W, H), [
    { op: 'combo', keys: ['shift', 'meta', 'c'] },
  ]);
  assert.deepEqual(toControlOps({ k: 'key', key: 'wat' }, W, H), []);
});

test('text types plainly, but a single modified char is a combo', () => {
  assert.deepEqual(toControlOps({ k: 'text', text: 'hello' }, W, H), [{ op: 'type', text: 'hello' }]);
  assert.deepEqual(toControlOps({ k: 'text', text: 'c', mods: ['ctrl'] }, W, H), [
    { op: 'combo', keys: ['ctrl', 'c'] },
  ]);
  // a modified char with no key mapping still types rather than vanishing
  assert.deepEqual(toControlOps({ k: 'text', text: '@', mods: ['ctrl'] }, W, H), [{ op: 'type', text: '@' }]);
  assert.equal(toControlOps({ k: 'text', text: 'x'.repeat(MAX_TEXT + 5) }, W, H)[0].text.length, MAX_TEXT);
  assert.deepEqual(toControlOps({ k: 'text', text: '' }, W, H), []);
});

test('garbage items map to nothing', () => {
  assert.deepEqual(toControlOps(null, W, H), []);
  assert.deepEqual(toControlOps({ k: 'explode' }, W, H), []);
  assert.deepEqual(toControlOps('tap', W, H), []);
});

test('normalizeCursor maps into 0..1 and nulls outside the display', () => {
  const b = { x: 0, y: 0, width: 1280, height: 800 };
  assert.deepEqual(normalizeCursor({ x: 640, y: 400 }, b), { cx: 0.5, cy: 0.5 });
  assert.equal(normalizeCursor({ x: -10, y: 400 }, b), null);
  assert.equal(normalizeCursor({ x: 1281, y: 400 }, b), null);
  // a secondary display offset still normalizes against its own bounds
  assert.deepEqual(normalizeCursor({ x: 1920 + 960, y: 540 }, { x: 1920, y: 0, width: 1920, height: 1080 }), { cx: 0.5, cy: 0.5 });
  assert.equal(normalizeCursor({ x: 5, y: 5 }, null), null);
});
