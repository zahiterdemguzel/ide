const test = require('node:test');
const assert = require('node:assert');
const { compileQuery, matchesTerms, querySessions, DEFAULT_LIMIT, MAX_LIMIT } = require('../src/main/session-query-lib');

// Sessions in creation order, the shape `query-sessions` builds them in.
function rows(...specs) {
  return specs.map(([name, archived, firstPrompt = '']) => ({
    id: name, repo: '/r', name, firstPrompt, archived, state: 'idle', live: false,
  }));
}

const sample = rows(
  ['alpha', false],
  ['beta', true],
  ['gamma', true],
  ['delta', false],
);

test('query terms: blank query compiles to no terms', () => {
  assert.deepEqual(compileQuery(''), []);
  assert.deepEqual(compileQuery('   '), []);
  assert.deepEqual(compileQuery(null), []);
});

test('query terms: whitespace splits into ANDed substrings, extensions match by suffix', () => {
  assert.deepEqual(compileQuery('foo BAR'), [{ sub: 'foo' }, { sub: 'bar' }]);
  assert.deepEqual(compileQuery('*.png'), [{ suffix: '.png' }]);
  assert.deepEqual(compileQuery('.md'), [{ suffix: '.md' }]);

  assert.equal(matchesTerms(compileQuery('fix login'), 'Fix the login bug'), true);
  assert.equal(matchesTerms(compileQuery('fix login'), 'Fix the signup bug'), false);
  assert.equal(matchesTerms(compileQuery('.md'), 'update README.md'), true);
  assert.equal(matchesTerms(compileQuery('.md'), 'update README.txt'), false);
});

test('tab filter selects active, archived, or all', () => {
  const active = querySessions(sample, { tab: 'active' });
  assert.deepEqual(active.items.map((s) => s.name), ['delta', 'alpha']);

  const archived = querySessions(sample, { tab: 'archived' });
  assert.deepEqual(archived.items.map((s) => s.name), ['gamma', 'beta']);

  const all = querySessions(sample, { tab: 'all' });
  assert.equal(all.items.length, 4);
});

test('an unknown tab falls back to active rather than leaking archived rows', () => {
  const r = querySessions(sample, { tab: 'nonsense' });
  assert.deepEqual(r.items.map((s) => s.name), ['delta', 'alpha']);
});

test('every tab lists newest first', () => {
  const r = querySessions(sample, { tab: 'all' });
  assert.deepEqual(r.items.map((s) => s.name), ['delta', 'gamma', 'beta', 'alpha']);
});

test('counts are per-tab totals and ignore the search filter', () => {
  const r = querySessions(sample, { tab: 'archived', query: 'gamma' });
  assert.deepEqual(r.counts, { active: 2, archived: 2, all: 4 });
  // `total` is the filtered size of the queried tab — what the page is drawn from.
  assert.equal(r.total, 1);
  assert.deepEqual(r.items.map((s) => s.name), ['gamma']);
});

test('search matches the first prompt as well as the name', () => {
  const list = rows(['s1', true, 'refactor the parser'], ['s2', true, 'write docs']);
  const r = querySessions(list, { tab: 'archived', query: 'parser' });
  assert.deepEqual(r.items.map((s) => s.name), ['s1']);
});

test('paging slices the filtered tab and reports the full total', () => {
  const many = rows(...Array.from({ length: 10 }, (_, i) => [`s${i}`, true]));

  const first = querySessions(many, { tab: 'archived', offset: 0, limit: 4 });
  assert.deepEqual(first.items.map((s) => s.name), ['s9', 's8', 's7', 's6']);
  assert.equal(first.total, 10);

  const second = querySessions(many, { tab: 'archived', offset: 4, limit: 4 });
  assert.deepEqual(second.items.map((s) => s.name), ['s5', 's4', 's3', 's2']);

  const tail = querySessions(many, { tab: 'archived', offset: 8, limit: 4 });
  assert.deepEqual(tail.items.map((s) => s.name), ['s1', 's0']);

  // Past the end is empty, not an error — a client that over-scrolls just stops.
  assert.deepEqual(querySessions(many, { tab: 'archived', offset: 99, limit: 4 }).items, []);
});

test('limit is clamped and defaulted so one page can never pull the whole archive', () => {
  const many = rows(...Array.from({ length: 300 }, (_, i) => [`s${i}`, true]));

  assert.equal(querySessions(many, { tab: 'archived' }).items.length, DEFAULT_LIMIT);
  assert.equal(querySessions(many, { tab: 'archived', limit: 0 }).items.length, DEFAULT_LIMIT);
  assert.equal(querySessions(many, { tab: 'archived', limit: 9999 }).items.length, MAX_LIMIT);
  assert.equal(querySessions(many, { tab: 'archived', limit: -5 }).items.length, 1);
  assert.equal(querySessions(many, { tab: 'archived', offset: -3, limit: 2 }).items[0].name, 's299');
});

test('an empty set yields an empty page and zeroed counts', () => {
  const r = querySessions([], { tab: 'archived', query: 'x' });
  assert.deepEqual(r, { items: [], total: 0, counts: { active: 0, archived: 0, all: 0 } });
});
