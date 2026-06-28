import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery, matchesTerms, matchesQuery } from '../src/renderer/shared/name-match.js';

test('blank query compiles to no terms (matches everything)', () => {
  assert.deepEqual(compileQuery(''), []);
  assert.deepEqual(compileQuery('   '), []);
  assert.equal(matchesQuery('anything', ''), true);
});

test('substring match is case-insensitive', () => {
  assert.equal(matchesQuery('Fix the login bug', 'login'), true);
  assert.equal(matchesQuery('Fix the login bug', 'LOGIN'), true);
  assert.equal(matchesQuery('Fix the login bug', 'logout'), false);
});

test('all whitespace-split terms must match', () => {
  assert.equal(matchesQuery('refactor the git pane', 'git pane'), true);
  assert.equal(matchesQuery('refactor the git pane', 'git terminal'), false);
});

test('a ".ext"/"*.ext" term matches by suffix', () => {
  const terms = compileQuery('.png');
  assert.equal(matchesTerms(terms, 'sprites/enemy.png'), true);
  assert.equal(matchesTerms(terms, 'enemy.png.bak'), false);
  assert.deepEqual(compileQuery('*.png'), compileQuery('.png'));
});

test('folding matches Turkish accents case-insensitively', () => {
  assert.equal(matchesQuery('İstanbul haritası', 'istanbul'), true);
  assert.equal(matchesQuery('ŞÇÖÜ session', 'şçöü'), true);
});

test('null/undefined haystack and query are handled', () => {
  assert.equal(matchesQuery(undefined, 'x'), false);
  assert.equal(matchesQuery('x', undefined), true);
  assert.equal(matchesQuery(undefined, undefined), true);
});
