import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelName, makeEntry, appendEntry, matchesFilter, countsByLevel, formatValue, MAX_ENTRIES }
  from '../src/renderer/shared/web-console-lib.js';

test('console levels normalize from both Chromium shapes', () => {
  // Electron 31 passes the integer, newer builds the name — the drawer colours
  // rows off this, so a miss would silently paint errors as plain logs.
  assert.equal(levelName(0), 'verbose');
  assert.equal(levelName(1), 'info');
  assert.equal(levelName(2), 'warning');
  assert.equal(levelName(3), 'error');
  assert.equal(levelName('warn'), 'warning');
  assert.equal(levelName('DEBUG'), 'verbose');
  assert.equal(levelName('log'), 'info');
  assert.equal(levelName(undefined), 'info');
  assert.equal(levelName('nonsense'), 'info');
});

test('an identical consecutive message bumps a count instead of adding a row', () => {
  const entries = [];
  appendEntry(entries, makeEntry('log', 'error', 'boom'));
  const second = appendEntry(entries, makeEntry('log', 'error', 'boom'));
  assert.equal(second.added, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);

  // A different level, different text, or an interleaved row all break the run.
  appendEntry(entries, makeEntry('log', 'warning', 'boom'));
  appendEntry(entries, makeEntry('log', 'warning', 'boom '));
  assert.equal(entries.length, 3);
});

test('typed input and results never collapse — two identical commands are two interactions', () => {
  const entries = [];
  appendEntry(entries, makeEntry('input', 'info', '1+1'));
  appendEntry(entries, makeEntry('input', 'info', '1+1'));
  assert.equal(entries.length, 2);
});

test('the list is capped, dropping the oldest', () => {
  const entries = [];
  for (let i = 0; i < MAX_ENTRIES + 20; i++) appendEntry(entries, makeEntry('log', 'info', `m${i}`));
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(entries[0].text, 'm20');
});

test('filtering matches on text and level, but never hides the user\'s own lines', () => {
  const err = makeEntry('log', 'error', 'Failed to fetch');
  const info = makeEntry('log', 'info', 'ready');
  const typed = makeEntry('input', 'info', 'location.href');

  assert.equal(matchesFilter(err, { level: 'error' }), true);
  assert.equal(matchesFilter(info, { level: 'error' }), false);
  assert.equal(matchesFilter(info, { level: 'all' }), true);
  // Input/result rows survive a level filter…
  assert.equal(matchesFilter(typed, { level: 'error' }), true);
  // …but not a text filter that excludes them.
  assert.equal(matchesFilter(typed, { text: 'fetch' }), false);
  assert.equal(matchesFilter(err, { text: 'FETCH' }), true);
  assert.equal(matchesFilter(err, { text: '   ' }), true);
});

test('badge counts only count page output', () => {
  const entries = [];
  appendEntry(entries, makeEntry('log', 'error', 'a'));
  appendEntry(entries, makeEntry('log', 'warning', 'b'));
  appendEntry(entries, makeEntry('log', 'warning', 'c'));
  appendEntry(entries, makeEntry('input', 'info', 'd'));
  assert.deepEqual(countsByLevel(entries), { error: 1, warning: 2 });
});

test('evaluated values format like a console, and survive cycles', () => {
  assert.equal(formatValue('hi'), 'hi'); // top-level strings unquoted
  assert.equal(formatValue(undefined), 'undefined');
  assert.equal(formatValue(null), 'null');
  assert.equal(formatValue(42), '42');
  assert.equal(formatValue({ a: 1 }), '{\n  "a": 1\n}');

  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.match(formatValue(cyclic), /\[Circular\]/);

  // A DOM-ish value that can't be JSON'd must still print something.
  assert.equal(formatValue(Symbol('s')), 'Symbol(s)');
});
