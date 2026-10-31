import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchText, searchTerms, matchesSearch } from '../src/renderer/shared/settings-search.js';

test('normalizeSearchText: folds case, accents, Turkish i and whitespace', () => {
  assert.equal(normalizeSearchText('  Señal   Sonora '), 'senal sonora');
  assert.equal(normalizeSearchText('DİL'), 'dil');
  assert.equal(normalizeSearchText('Bildirım'), 'bildirim');
  assert.equal(normalizeSearchText(undefined), '');
});

test('searchTerms: splits on whitespace, empty query has no terms', () => {
  assert.deepEqual(searchTerms('  Token   Cost '), ['token', 'cost']);
  assert.deepEqual(searchTerms('   '), []);
});

test('matchesSearch: every term must appear, in any order', () => {
  const text = 'Token cost meter Show tokens and cost';
  assert.ok(matchesSearch(text, searchTerms('cost token')));
  assert.ok(matchesSearch(text, searchTerms('MET')));
  assert.ok(!matchesSearch(text, searchTerms('token sound')));
});

test('matchesSearch: no terms matches everything', () => {
  assert.ok(matchesSearch('anything', []));
  assert.ok(matchesSearch('', searchTerms('')));
});

test('matchesSearch: accent-insensitive both ways', () => {
  assert.ok(matchesSearch('Thème', searchTerms('theme')));
  assert.ok(matchesSearch('Theme', searchTerms('thème')));
});
