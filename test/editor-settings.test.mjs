import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITOR_DEFAULTS, normalizeSettings, toMonacoOptions, toModelOptions, loadSettings, saveSettings, STORE_KEY,
} from '../src/renderer/editor/editor-settings.js';
import { symbolPathAt, relativeTime } from '../src/renderer/editor/symbol-path.js';

test('normalizeSettings: drops wrong types and unknown choices, clamps numbers', () => {
  const s = normalizeSettings({ fontSize: 99, tabSize: '2', lineNumbers: 'weird', minimap: false, bogus: 1 });
  assert.equal(s.fontSize, 40);
  assert.equal(s.tabSize, EDITOR_DEFAULTS.tabSize);
  assert.equal(s.lineNumbers, 'on');
  assert.equal(s.minimap, false);
  assert.ok(!('bogus' in s));
  assert.deepEqual(normalizeSettings(null), EDITOR_DEFAULTS);
});

test('toMonacoOptions / toModelOptions map preferences onto Monaco options', () => {
  const o = toMonacoOptions({ ...EDITOR_DEFAULTS, wordWrap: true, minimap: false, fontFamily: 'Fira Code' });
  assert.equal(o.wordWrap, 'on');
  assert.equal(o.minimap.enabled, false);
  assert.equal(o.fontFamily, 'Fira Code');
  assert.ok(toMonacoOptions(EDITOR_DEFAULTS).fontFamily.includes('monospace'));
  assert.deepEqual(toModelOptions({ ...EDITOR_DEFAULTS, tabSize: 2, insertSpaces: false }), { tabSize: 2, insertSpaces: false });
});

test('loadSettings / saveSettings round-trip through storage and survive junk', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveSettings(storage, { ...EDITOR_DEFAULTS, fontSize: 16 });
  assert.equal(loadSettings(storage).fontSize, 16);
  mem.set(STORE_KEY, '{not json');
  assert.deepEqual(loadSettings(storage), EDITOR_DEFAULTS);
});

const range = (a, b, c, d) => ({ startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d });

test('symbolPathAt: walks nested symbols containing the caret', () => {
  const symbols = [
    { name: 'A', range: range(1, 1, 10, 1), children: [
      { name: 'm1', range: range(2, 3, 4, 3), children: [] },
      { name: 'm2', range: range(5, 3, 9, 3), children: [] },
    ] },
    { name: 'B', range: range(12, 1, 20, 1), children: [] },
  ];
  assert.deepEqual(symbolPathAt(symbols, 6, 1).map((s) => s.name), ['A', 'm2']);
  assert.deepEqual(symbolPathAt(symbols, 11, 1), []);
  assert.deepEqual(symbolPathAt(null, 1, 1), []);
});

test('relativeTime: picks the largest whole unit', () => {
  const now = Date.UTC(2026, 0, 10);
  assert.equal(relativeTime(now - 3 * 24 * 3600e3, now), '3 days ago');
  assert.equal(relativeTime(now - 2 * 3600e3, now), '2 hours ago');
  assert.equal(relativeTime(now - 5e3, now), 'now');
});

test('AI inline completions are off by default (each suggestion spends tokens)', () => {
  assert.equal(EDITOR_DEFAULTS.inlineCompletions, false);
  assert.equal(normalizeSettings({}).inlineCompletions, false);
  assert.equal(normalizeSettings({ inlineCompletions: true }).inlineCompletions, true);
});
