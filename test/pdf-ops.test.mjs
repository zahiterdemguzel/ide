import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePages, rotatePage, deletePage, movePage, isIdentity } from '../src/renderer/shared/pdf-ops.js';

test('makePages: identity list of source indices with zero rotation', () => {
  assert.deepEqual(makePages(3), [
    { src: 0, rotation: 0 }, { src: 1, rotation: 0 }, { src: 2, rotation: 0 },
  ]);
  assert.deepEqual(makePages(0), []);
});

test('rotatePage: adds delta, normalizes to 0..270, does not mutate', () => {
  const pages = makePages(2);
  const r = rotatePage(pages, 1, 90);
  assert.equal(r[1].rotation, 90);
  assert.equal(pages[1].rotation, 0);
  assert.equal(rotatePage(r, 1, 90)[1].rotation, 180);
  assert.equal(rotatePage(rotatePage(r, 1, 90), 1, 180)[1].rotation, 0);
});

test('rotatePage: negative delta wraps (counter-clockwise)', () => {
  assert.equal(rotatePage(makePages(1), 0, -90)[0].rotation, 270);
});

test('rotatePage: out-of-range index is a no-op returning the same array', () => {
  const pages = makePages(2);
  assert.equal(rotatePage(pages, 5, 90), pages);
  assert.equal(rotatePage(pages, -1, 90), pages);
});

test('deletePage: removes the page, keeps order', () => {
  const r = deletePage(makePages(3), 1);
  assert.deepEqual(r.map((p) => p.src), [0, 2]);
});

test('deletePage: refuses to empty the document or delete out of range', () => {
  const one = makePages(1);
  assert.equal(deletePage(one, 0), one);
  const three = makePages(3);
  assert.equal(deletePage(three, 3), three);
});

test('movePage: reorders in both directions', () => {
  assert.deepEqual(movePage(makePages(4), 0, 2).map((p) => p.src), [1, 2, 0, 3]);
  assert.deepEqual(movePage(makePages(4), 3, 0).map((p) => p.src), [3, 0, 1, 2]);
});

test('movePage: same position or out of range is a no-op', () => {
  const pages = makePages(3);
  assert.equal(movePage(pages, 1, 1), pages);
  assert.equal(movePage(pages, 1, 3), pages);
  assert.equal(movePage(pages, -1, 0), pages);
});

test('isIdentity: true only for the untouched list', () => {
  const pages = makePages(3);
  assert.equal(isIdentity(pages, 3), true);
  assert.equal(isIdentity(rotatePage(pages, 0, 90), 3), false);
  assert.equal(isIdentity(deletePage(pages, 2), 3), false);
  assert.equal(isIdentity(movePage(pages, 0, 1), 3), false);
  // a move undone by a second move is identity again
  assert.equal(isIdentity(movePage(movePage(pages, 0, 1), 1, 0), 3), true);
});
