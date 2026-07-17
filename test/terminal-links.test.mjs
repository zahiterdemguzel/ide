import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTerminalLinks, looksLikePath, mapSpanToRows, MAX_LINK_ROWS } from '../src/renderer/shared/terminal-links-parse.js';

const raws = (text) => findTerminalLinks(text).map((l) => `${l.kind}:${l.raw}`);

test('looksLikePath: a token with a separator is always a path', () => {
  assert.equal(looksLikePath('src/main/index.js'), true);
  assert.equal(looksLikePath('./a'), true);
  assert.equal(looksLikePath('C:\\Users\\x'), true);
  assert.equal(looksLikePath('~/notes'), true);
});

test('looksLikePath: a bare filename needs a known extension', () => {
  assert.equal(looksLikePath('renderer.js'), true);
  assert.equal(looksLikePath('README.md'), true);
  assert.equal(looksLikePath('photo.png'), true);   // image ext
  assert.equal(looksLikePath('server.log'), true);  // extra-allowed ext
  assert.equal(looksLikePath('notes.xyzzy'), false); // unknown ext
  assert.equal(looksLikePath('justaword'), false);   // no ext, no separator
});

test('looksLikePath: a trailing :line[:col] is ignored when judging the core', () => {
  assert.equal(looksLikePath('index.js:42'), true);
  assert.equal(looksLikePath('index.js:42:8'), true);
  assert.equal(looksLikePath('a'), false); // too short after stripping
});

test('findTerminalLinks: extracts an http(s) URL as a url link', () => {
  assert.deepEqual(raws('see https://example.com/docs for more'), ['url:https://example.com/docs']);
});

test('findTerminalLinks: a trailing paren is not swallowed into the URL', () => {
  assert.deepEqual(raws('(https://example.com)'), ['url:https://example.com']);
});

test('findTerminalLinks: extracts a path with a line/col suffix', () => {
  const found = findTerminalLinks('  at src/renderer/index.js:120:5');
  const path = found.find((l) => l.kind === 'path');
  assert.ok(path, 'expected a path link');
  assert.equal(path.raw, 'src/renderer/index.js:120:5');
});

test('findTerminalLinks: plain prose words are not links', () => {
  assert.deepEqual(findTerminalLinks('the quick brown fox jumped'), []);
});

test('findTerminalLinks: URL wins over path on overlapping ranges (no double-match)', () => {
  // the URL contains "example.com" which is path-shaped; it must not also be
  // reported as a path link.
  const found = findTerminalLinks('https://example.com/a.js');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'url');
});

test('findTerminalLinks: reports correct start/end offsets', () => {
  const text = 'go to index.js now';
  const [link] = findTerminalLinks(text);
  assert.equal(link.kind, 'path');
  assert.equal(text.slice(link.start, link.end), 'index.js');
});

test('findTerminalLinks: matches a very long URL spanning several wrapped rows worth of text', () => {
  const url = 'https://example.com/' + 'a'.repeat(80 * (MAX_LINK_ROWS - 1));
  assert.deepEqual(raws(`see ${url} end`), [`url:${url}`]);
});

test('mapSpanToRows: span inside a single row', () => {
  assert.deepEqual(mapSpanToRows([80, 80], 5, 15), { startRow: 0, startCol: 5, endRow: 0, endCol: 14 });
});

test('mapSpanToRows: span crossing a wrap boundary lands on both rows', () => {
  // 80-col rows; link runs from col 70 of row 0 through col 9 of row 1.
  assert.deepEqual(mapSpanToRows([80, 80], 70, 90), { startRow: 0, startCol: 70, endRow: 1, endCol: 9 });
});

test('mapSpanToRows: offset exactly at a row start maps to that row, col 0', () => {
  assert.deepEqual(mapSpanToRows([80, 80], 80, 85), { startRow: 1, startCol: 0, endRow: 1, endCol: 4 });
});

test('mapSpanToRows: empty span yields null', () => {
  assert.equal(mapSpanToRows([80], 5, 5), null);
});

test('findTerminalLinks: finds multiple distinct links in one line', () => {
  const got = raws('open src/a.js and https://x.io/y');
  assert.ok(got.includes('path:src/a.js'));
  assert.ok(got.includes('url:https://x.io/y'));
});
