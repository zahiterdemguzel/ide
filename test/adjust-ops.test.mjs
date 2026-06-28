import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENTS, DEFAULTS, isNeutral, buildChannelLuts, applyAdjustments } from '../src/renderer/shared/adjust-ops.js';

// One RGBA pixel as a buffer the pipeline accepts.
const px = (r, g, b, a = 255) => Uint8ClampedArray.from([r, g, b, a]);
const run = (src, v) => { const dst = new Uint8ClampedArray(src.length); applyAdjustments(src, dst, v); return dst; };

test('DEFAULTS: every control is 0 and counts as neutral', () => {
  for (const a of ADJUSTMENTS) assert.equal(DEFAULTS[a.key], 0);
  assert.equal(isNeutral({ ...DEFAULTS }), true);
  assert.equal(isNeutral({ ...DEFAULTS, contrast: 5 }), false);
});

test('buildChannelLuts: neutral values give an identity LUT for every channel', () => {
  const { r, g, b } = buildChannelLuts({ ...DEFAULTS });
  for (let i = 0; i < 256; i++) {
    assert.equal(r[i], i);
    assert.equal(g[i], i);
    assert.equal(b[i], i);
  }
});

test('applyAdjustments: neutral is an exact copy and preserves alpha', () => {
  const src = px(40, 120, 200, 128);
  assert.deepEqual([...run(src, { ...DEFAULTS })], [40, 120, 200, 128]);
});

test('applyAdjustments: brightness lifts and lowers every channel', () => {
  const src = px(100, 100, 100);
  assert.ok(run(src, { ...DEFAULTS, brightness: 40 })[0] > 100);
  assert.ok(run(src, { ...DEFAULTS, brightness: -40 })[0] < 100);
});

test('applyAdjustments: contrast widens the spread around mid-grey', () => {
  const dark = run(px(60, 60, 60), { ...DEFAULTS, contrast: 50 })[0];
  const light = run(px(200, 200, 200), { ...DEFAULTS, contrast: 50 })[0];
  assert.ok(dark < 60, 'a dark pixel darkens');
  assert.ok(light > 200, 'a light pixel lightens');
});

test('applyAdjustments: saturation −100 collapses to grey (r=g=b≈luma)', () => {
  const [r, g, b] = run(px(200, 50, 10), { ...DEFAULTS, saturation: -100 });
  assert.equal(r, g);
  assert.equal(g, b);
  const luma = Math.round(0.299 * 200 + 0.587 * 50 + 0.114 * 10);
  assert.ok(Math.abs(r - luma) <= 1);
});

test('applyAdjustments: positive saturation pushes a colour further from grey', () => {
  const base = px(150, 110, 90);
  const out = run(base, { ...DEFAULTS, saturation: 80 });
  assert.ok(out[0] > 150, 'the dominant channel grows');
  assert.ok(out[2] < 90, 'the weakest channel shrinks');
});

test('applyAdjustments: warm temperature lifts red and drops blue', () => {
  const [r, , b] = run(px(120, 120, 120), { ...DEFAULTS, temperature: 80 });
  assert.ok(r > 120, 'red warms up');
  assert.ok(b < 120, 'blue cools down');
});

test('applyAdjustments: tint shifts the green channel', () => {
  const magenta = run(px(120, 120, 120), { ...DEFAULTS, tint: 80 })[1];
  const green = run(px(120, 120, 120), { ...DEFAULTS, tint: -80 })[1];
  assert.ok(magenta < 120, '+tint removes green (magenta)');
  assert.ok(green > 120, '−tint adds green');
});

test('applyAdjustments: vibrance boosts a muted pixel more than an already-vivid one', () => {
  const muted = px(140, 120, 120);
  const vivid = px(240, 20, 20);
  const spread = (p, out) => Math.max(...out) - Math.min(...out) - (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]));
  const mutedGain = spread(muted, run(muted, { ...DEFAULTS, vibrance: 100 }));
  const vividGain = spread(vivid, run(vivid, { ...DEFAULTS, vibrance: 100 }));
  assert.ok(mutedGain > 0);
  assert.ok(mutedGain > vividGain);
});
