const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  MAX_CANDIDATES, splitLocation, trimDecoration, candidatePath, openFolderRelative, normalizeCandidates,
} = require('../src/main/chat-links-lib');

const REPO = path.resolve('/work/app');
const HOME = path.resolve('/home/me');

test('splitLocation: line suffixes in the compiler and GitHub shapes', () => {
  assert.deepEqual(splitLocation('src/a.js:12:3'), { file: 'src/a.js', line: 12 });
  assert.deepEqual(splitLocation('src/a.js:12'), { file: 'src/a.js', line: 12 });
  assert.deepEqual(splitLocation('src/a.js#L40'), { file: 'src/a.js', line: 40 });
  assert.deepEqual(splitLocation('src/a.js#L40-L52'), { file: 'src/a.js', line: 40 });
  assert.deepEqual(splitLocation('src/a.js'), { file: 'src/a.js', line: 0 });
});

test('trimDecoration: quotes, brackets and sentence punctuation are not part of the name', () => {
  assert.equal(trimDecoration('`src/a.js`'), 'src/a.js');
  assert.equal(trimDecoration('(src/a.js),'), 'src/a.js');
  assert.equal(trimDecoration('"README.md".'), 'README.md');
  assert.equal(trimDecoration('src/a.js:12:'), 'src/a.js:12');
  assert.equal(trimDecoration('./a.js'), './a.js', 'a leading ./ is meaningful and stays');
});

test('candidatePath: relative tokens resolve against the session tree, not the open folder', () => {
  const cwd = path.join(REPO, '.claude/worktrees/s1');
  assert.deepEqual(candidatePath('src/a.js:7', { cwd, home: HOME }), { abs: path.join(cwd, 'src/a.js'), line: 7 });
  assert.deepEqual(candidatePath('./a.js', { cwd: REPO, home: HOME }), { abs: path.join(REPO, 'a.js'), line: 0 });
});

test('candidatePath: absolute and home-relative tokens', () => {
  const abs = path.join(REPO, 'src', 'a.js');
  assert.deepEqual(candidatePath(abs, { cwd: '/elsewhere', home: HOME }), { abs, line: 0 });
  assert.deepEqual(candidatePath('~/notes.md', { cwd: REPO, home: HOME }), { abs: path.join(HOME, 'notes.md'), line: 0 });
});

test('candidatePath: URLs and empty tokens are never files', () => {
  assert.equal(candidatePath('https://example.com/a.js', { cwd: REPO, home: HOME }), null);
  assert.equal(candidatePath('file:///etc/passwd', { cwd: REPO, home: HOME }), null);
  assert.equal(candidatePath('``', { cwd: REPO, home: HOME }), null);
  assert.equal(candidatePath('a.js', { cwd: '', home: HOME }), null, 'no tree to resolve against');
});

test('openFolderRelative: only paths inside the open folder are linkable', () => {
  assert.equal(openFolderRelative(path.join(REPO, 'src', 'a.js'), REPO), 'src/a.js');
  assert.equal(openFolderRelative(path.join(REPO, '.claude/worktrees/s1/a.js'), REPO), '.claude/worktrees/s1/a.js');
  assert.equal(openFolderRelative(path.resolve('/work/other/a.js'), REPO), null);
  assert.equal(openFolderRelative(path.resolve('/work/app-two/a.js'), REPO), null, 'a sibling sharing the prefix is outside');
  assert.equal(openFolderRelative(REPO, REPO), null, 'the folder itself is not a file');
  assert.equal(openFolderRelative(path.join(REPO, 'a.js'), null), null);
});

test('normalizeCandidates: unique strings only, capped', () => {
  assert.deepEqual(normalizeCandidates(['a.js', 'a.js', '', 3, null, 'b.js']), ['a.js', 'b.js']);
  assert.deepEqual(normalizeCandidates('a.js'), []);
  const many = Array.from({ length: MAX_CANDIDATES + 50 }, (_, i) => `f${i}.js`);
  assert.equal(normalizeCandidates(many).length, MAX_CANDIDATES);
});
