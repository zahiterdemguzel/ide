import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTerminalLinks, looksLikePath } from '../src/renderer/shared/terminal-links-parse.js';

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

test('findTerminalLinks: finds multiple distinct links in one line', () => {
  const got = raws('open src/a.js and https://x.io/y');
  assert.ok(got.includes('path:src/a.js'));
  assert.ok(got.includes('url:https://x.io/y'));
});
