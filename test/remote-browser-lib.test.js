const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeBrowserUrl, clampViewport, toInputEvents, createFrameGate, uaForMode,
  MIN_W, MAX_W, MIN_H, MAX_H,
} = require('../src/main/remote-browser-lib');

test('uaForMode masquerades only in mobile mode', () => {
  assert.match(uaForMode('mobile'), /Android.*Mobile Safari/);
  assert.equal(uaForMode('desktop'), null); // keep Electron's own desktop UA
  assert.equal(uaForMode(undefined), null);
  assert.equal(uaForMode('bogus'), null);
});

test('normalizeBrowserUrl accepts web addresses and defaults to https', () => {
  assert.equal(normalizeBrowserUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeBrowserUrl('http://example.com'), 'http://example.com/');
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeBrowserUrl('  example.com/path  '), 'https://example.com/path');
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'https://localhost:3000/');
});

test('normalizeBrowserUrl rejects non-web schemes and garbage', () => {
  assert.equal(normalizeBrowserUrl('file:///etc/passwd'), null);
  assert.equal(normalizeBrowserUrl('javascript:alert(1)'), null);
  assert.equal(normalizeBrowserUrl('about:blank'), null);
  assert.equal(normalizeBrowserUrl('chrome://settings'), null);
  assert.equal(normalizeBrowserUrl('justaword'), null); // no dot, not a host
  assert.equal(normalizeBrowserUrl(''), null);
  assert.equal(normalizeBrowserUrl('   '), null);
  assert.equal(normalizeBrowserUrl(42), null);
  assert.equal(normalizeBrowserUrl(undefined), null);
});

test('clampViewport bounds sizes and survives garbage', () => {
  assert.deepEqual(clampViewport({ width: 480, height: 800 }), { width: 480, height: 800 });
  assert.deepEqual(clampViewport({ width: 10, height: 99999 }), { width: MIN_W, height: MAX_H });
  assert.deepEqual(clampViewport({ width: 99999, height: 10 }), { width: MAX_W, height: MIN_H });
  assert.deepEqual(clampViewport({}), { width: MIN_W, height: MIN_H });
  assert.deepEqual(clampViewport(null), { width: MIN_W, height: MIN_H });
  assert.deepEqual(clampViewport({ width: 'x', height: NaN }), { width: MIN_W, height: MIN_H });
  assert.deepEqual(clampViewport({ width: 400.6, height: 700.2 }), { width: 401, height: 700 });
});

test('tap maps to a denormalized mouseDown+mouseUp pair', () => {
  const events = toInputEvents({ k: 'tap', x: 0.5, y: 0.25 }, 400, 800);
  assert.deepEqual(events, [
    { type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 200, y: 200, button: 'left', clickCount: 1 },
  ]);
});

test('scroll maps to a mouseWheel with rounded deltas', () => {
  const events = toInputEvents({ k: 'scroll', x: 0.5, y: 0.5, dx: -3.4, dy: 120.6 }, 400, 800);
  assert.deepEqual(events, [
    { type: 'mouseWheel', x: 200, y: 400, deltaX: -3, deltaY: 121 },
  ]);
});

test('text and key items map to char and keyDown/keyUp events', () => {
  assert.deepEqual(toInputEvents({ k: 'text', text: 'hi' }, 400, 800), [
    { type: 'char', keyCode: 'h' },
    { type: 'char', keyCode: 'i' },
  ]);
  assert.deepEqual(toInputEvents({ k: 'key', key: 'Enter' }, 400, 800), [
    { type: 'keyDown', keyCode: 'Enter' },
    { type: 'keyUp', keyCode: 'Enter' },
  ]);
});

test('malformed input items map to no events', () => {
  assert.deepEqual(toInputEvents(null, 400, 800), []);
  assert.deepEqual(toInputEvents({ k: 'tap', x: 2, y: 0.5 }, 400, 800), []); // out of 0..1
  assert.deepEqual(toInputEvents({ k: 'tap', x: -0.1, y: 0.5 }, 400, 800), []);
  assert.deepEqual(toInputEvents({ k: 'scroll', x: 0.5, y: 0.5, dx: 'a', dy: 1 }, 400, 800), []);
  assert.deepEqual(toInputEvents({ k: 'text', text: '' }, 400, 800), []);
  assert.deepEqual(toInputEvents({ k: 'key', key: 7 }, 400, 800), []);
  assert.deepEqual(toInputEvents({ k: 'nope' }, 400, 800), []);
});

test('frame gate paces sends to maxFps with a trailing window', () => {
  let t = 0;
  const gate = createFrameGate({ maxFps: 10, now: () => t }); // interval 100ms
  assert.equal(gate.interval, 100);
  assert.equal(gate.shouldSend(), true); // first frame goes immediately
  gate.mark();
  assert.equal(gate.shouldSend(), false);
  assert.equal(gate.pending(), 100); // full interval left right after a send
  t = 50;
  assert.equal(gate.shouldSend(), false);
  assert.equal(gate.pending(), 50);
  t = 100;
  assert.equal(gate.shouldSend(), true);
  assert.equal(gate.pending(), 0);
});
