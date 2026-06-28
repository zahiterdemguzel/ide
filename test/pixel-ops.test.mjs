import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floodFill } from '../src/renderer/shared/pixel-ops.js';

// Build a w×h RGBA buffer from a grid of single-letter colour codes.
const COLORS = {
  k: [0, 0, 0, 255],     // black
  w: [255, 255, 255, 255], // white
  r: [255, 0, 0, 255],   // red
  t: [0, 0, 0, 0],       // transparent
};
const make = (rows) => {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const [r, g, b, a] = COLORS[c];
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }));
  return { data, w, h };
};
// Read pixel (x,y) back as an [r,g,b,a] tuple.
const at = (g, x, y) => { const i = (y * g.w + x) * 4; return [g.data[i], g.data[i + 1], g.data[i + 2], g.data[i + 3]]; };

test('floodFill: fills a contiguous region of the seed colour', () => {
  const g = make(['kkk', 'kkk', 'kkk']);
  const changed = floodFill(g.data, g.w, g.h, 0, 0, COLORS.r, 0);
  assert.equal(changed, 9);
  assert.deepEqual(at(g, 0, 0), COLORS.r);
  assert.deepEqual(at(g, 2, 2), COLORS.r);
});

test('floodFill: stops at a colour boundary (4-connected)', () => {
  // a white cross splits the black field into four corner cells
  const g = make(['kwk', 'www', 'kwk']);
  const changed = floodFill(g.data, g.w, g.h, 0, 0, COLORS.r, 0);
  assert.equal(changed, 1); // only the top-left black cell, white walls it off
  assert.deepEqual(at(g, 0, 0), COLORS.r);
  assert.deepEqual(at(g, 2, 0), COLORS.k); // other corner untouched
  assert.deepEqual(at(g, 1, 1), COLORS.w); // wall untouched
});

test('floodFill: erase fills with transparent', () => {
  const g = make(['rr', 'rr']);
  floodFill(g.data, g.w, g.h, 0, 0, [0, 0, 0, 0], 0);
  assert.deepEqual(at(g, 0, 0), COLORS.t);
  assert.deepEqual(at(g, 1, 1), COLORS.t);
});

test('floodFill: threshold widens what counts as a match', () => {
  const near = [10, 10, 10, 255]; // close to black but not equal
  const g = make(['kk', 'kk']);
  const i = (1 * g.w + 1) * 4; // make bottom-right a near-black pixel
  g.data[i] = near[0]; g.data[i + 1] = near[1]; g.data[i + 2] = near[2]; g.data[i + 3] = near[3];

  // threshold 0 leaves the near-black pixel out
  const exact = floodFill(g.data.slice(), g.w, g.h, 0, 0, COLORS.r, 0);
  assert.equal(exact, 3);

  // a small threshold pulls it in
  const fuzzy = floodFill(g.data.slice(), g.w, g.h, 0, 0, COLORS.r, 10);
  assert.equal(fuzzy, 4);
});

test('floodFill: seed already the fill colour is a no-op', () => {
  const g = make(['rr', 'rr']);
  const changed = floodFill(g.data, g.w, g.h, 0, 0, COLORS.r, 0);
  assert.equal(changed, 0);
});

test('floodFill: out-of-bounds seed changes nothing', () => {
  const g = make(['kk', 'kk']);
  assert.equal(floodFill(g.data, g.w, g.h, -1, 0, COLORS.r, 0), 0);
  assert.equal(floodFill(g.data, g.w, g.h, 5, 5, COLORS.r, 0), 0);
});
