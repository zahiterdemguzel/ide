import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, fuzzyFilter } from '../src/renderer/shared/fuzzy.js';
import { fold } from '../src/renderer/shared/text-fold.js';

test('fuzzyMatch: requires a subsequence, in order', () => {
  assert.ok(fuzzyMatch('app', 'src/app.js'));
  assert.ok(fuzzyMatch('aj', 'app.js'));        // gaps are fine
  assert.equal(fuzzyMatch('xyz', 'app.js'), null);
  assert.equal(fuzzyMatch('ja', 'app.js'), null); // out of order
});

test('fuzzyMatch: matches Turkish letters case-insensitively', () => {
  assert.ok(fuzzyMatch('güzel', 'src/Güzel.js'));
  assert.ok(fuzzyMatch('istanbul', 'İstanbul.txt'));
});

test('fuzzyMatch: positions stay aligned to the original target past a İ', () => {
  // fold() is length-preserving, so a position indexes target[i] directly even
  // though "İ" would lowercase to two units. The matched chars (folded) must be
  // the folded query, in order.
  const target = 'İstanbul/Şehir.js';
  const { positions } = fuzzyMatch('şehir', target);
  const matched = positions.map((i) => target[i]).join('');
  assert.equal(fold(matched), fold('şehir'));
});

test('fuzzyMatch: empty query matches everything neutrally', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, positions: [] });
});

test('fuzzyMatch: positions point at the matched characters', () => {
  assert.deepEqual(fuzzyMatch('app', 'app.js').positions, [0, 1, 2]);
  assert.deepEqual(fuzzyMatch('aj', 'app.js').positions, [0, 4]);
});

test('fuzzyMatch: matching is case-insensitive', () => {
  assert.ok(fuzzyMatch('APP', 'app.js'));
  assert.ok(fuzzyMatch('app', 'App.JS'));
});

test('fuzzyMatch: whitespace in the query is ignored', () => {
  assert.ok(fuzzyMatch('app js', 'app.js'));
});

test('fuzzyMatch: a consecutive run scores higher than a scattered one', () => {
  // No boundaries on either side, so only the consecutive bonus differs.
  const run = fuzzyMatch('app', 'xappx').score;        // a-p-p consecutive
  const scattered = fuzzyMatch('app', 'xaxpxpx').score; // same chars, gaps
  assert.ok(run > scattered, `${run} should beat ${scattered}`);
});

test('fuzzyMatch: a basename match beats the same hit in a parent dir', () => {
  const inName = fuzzyMatch('app', 'src/app.js').score;
  const inDir = fuzzyMatch('app', 'app/src/main.js').score;
  assert.ok(inName > inDir, `${inName} should beat ${inDir}`);
});

test('fuzzyFilter: ranks the best structural match first', () => {
  const items = ['vendor/app.bundle.js', 'src/app.js', 'lib/zap.js'];
  const ranked = fuzzyFilter('app', items).map((r) => r.item);
  assert.equal(ranked[0], 'src/app.js');
  assert.ok(!ranked.includes('lib/zap.js')); // not a subsequence -> excluded
});

test('fuzzyFilter: drops non-matches and respects the limit', () => {
  const items = ['a.js', 'b.js', 'ab.js', 'c.txt'];
  const ranked = fuzzyFilter('ab', items, 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].item, 'ab.js');
});

test('fuzzyFilter: empty query returns the head of the list unscored', () => {
  const items = ['a', 'b', 'c'];
  const out = fuzzyFilter('', items, 2);
  assert.deepEqual(out, [{ item: 'a', positions: [] }, { item: 'b', positions: [] }]);
});
