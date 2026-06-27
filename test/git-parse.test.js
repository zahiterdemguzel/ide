const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePorcelain, parseLog, filterCommits, sumNumstat, CONFLICT } = require('../src/main/git-parse');

test('parsePorcelain: splits staged, unstaged, and untracked', () => {
  const out = [
    'M  staged-only.js',   // staged modification (X=M, Y=space)
    ' M unstaged-only.js', // unstaged modification (X=space, Y=M)
    'MM both.js',          // staged + unstaged
    'A  added.js',         // newly staged
    '?? untracked.js',     // untracked
  ].join('\n');
  const r = parsePorcelain(out);
  assert.deepEqual(r.staged, [
    { status: 'M', file: 'staged-only.js' },
    { status: 'M', file: 'both.js' },
    { status: 'A', file: 'added.js' },
  ]);
  assert.deepEqual(r.unstaged, [
    { status: 'M', file: 'unstaged-only.js' },
    { status: 'M', file: 'both.js' },
    { status: '?', file: 'untracked.js' },
  ]);
  assert.deepEqual(r.conflicts, []);
});

test('parsePorcelain: untracked never counts as staged', () => {
  const r = parsePorcelain('?? new.js');
  assert.deepEqual(r.staged, []);
  assert.deepEqual(r.unstaged, [{ status: '?', file: 'new.js' }]);
});

test('parsePorcelain: a rename uses the destination path', () => {
  const r = parsePorcelain('R  old/name.js -> new/name.js');
  assert.deepEqual(r.staged, [{ status: 'R', file: 'new/name.js' }]);
});

test('parsePorcelain: every unmerged state is a conflict, not staged/unstaged', () => {
  for (const state of CONFLICT) {
    const r = parsePorcelain(`${state} conflicted.js`);
    assert.deepEqual(r.conflicts, [{ status: state, file: 'conflicted.js' }], `state ${state}`);
    assert.deepEqual(r.staged, [], `state ${state} should not stage`);
    assert.deepEqual(r.unstaged, [], `state ${state} should not unstage`);
  }
});

test('parsePorcelain: blank lines and trailing newline are ignored', () => {
  const r = parsePorcelain('\n M a.js\n\n');
  assert.deepEqual(r.unstaged, [{ status: 'M', file: 'a.js' }]);
});

test('parsePorcelain: non-ASCII paths pass through verbatim (quotePath=false)', () => {
  const r = parsePorcelain(' M é.txt');
  assert.deepEqual(r.unstaged, [{ status: 'M', file: 'é.txt' }]);
});

test('parsePorcelain: empty input yields empty lists', () => {
  assert.deepEqual(parsePorcelain(''), { staged: [], unstaged: [], conflicts: [] });
});

test('parseLog: splits unit-separator fields into commit records', () => {
  const US = '\x1f';
  const out = [
    ['abc123def', 'abc123d', 'Fix the thing', 'Ada', '2 hours ago'].join(US),
    ['000111222', '0001112', 'Add a feature', 'Bob', '3 days ago'].join(US),
  ].join('\n');
  const commits = parseLog(out);
  assert.deepEqual(commits, [
    { hash: 'abc123def', short: 'abc123d', subject: 'Fix the thing', author: 'Ada', relDate: '2 hours ago' },
    { hash: '000111222', short: '0001112', subject: 'Add a feature', author: 'Bob', relDate: '3 days ago' },
  ]);
});

test('parseLog: a subject containing the field separator is not corrupted', () => {
  // Subjects are free text but git only emits \x1f between our chosen fields,
  // so a normal subject with punctuation stays intact.
  const US = '\x1f';
  const commits = parseLog(['h', 's', 'feat: do x, y (z)', 'A', 'now'].join(US));
  assert.equal(commits[0].subject, 'feat: do x, y (z)');
});

test('parseLog: empty input yields no commits', () => {
  assert.deepEqual(parseLog(''), []);
});

const COMMITS = [
  { hash: 'abc123def', short: 'abc123d', subject: 'Fix the login bug', author: 'Ada', relDate: '2 hours ago' },
  { hash: '000111222', short: '0001112', subject: 'Add a dark theme', author: 'Bob', relDate: '3 days ago' },
  { hash: '99ffee00aa', short: '99ffee0', subject: 'Refactor the parser', author: 'Ada', relDate: '1 week ago' },
];

test('filterCommits: blank query returns the list unchanged', () => {
  assert.equal(filterCommits(COMMITS, ''), COMMITS);
  assert.equal(filterCommits(COMMITS, '   '), COMMITS);
});

test('filterCommits: matches subject case-insensitively', () => {
  assert.deepEqual(filterCommits(COMMITS, 'DARK').map((c) => c.short), ['0001112']);
});

test('filterCommits: matches author', () => {
  assert.deepEqual(filterCommits(COMMITS, 'ada').map((c) => c.short), ['abc123d', '99ffee0']);
});

test('filterCommits: matches full or short hash', () => {
  assert.deepEqual(filterCommits(COMMITS, '99ffee0').map((c) => c.subject), ['Refactor the parser']);
  assert.deepEqual(filterCommits(COMMITS, 'abc123def').map((c) => c.subject), ['Fix the login bug']);
});

test('filterCommits: all whitespace-split terms must match (any field)', () => {
  assert.deepEqual(filterCommits(COMMITS, 'ada parser').map((c) => c.short), ['99ffee0']);
  assert.deepEqual(filterCommits(COMMITS, 'ada theme'), []);
});

test('sumNumstat: totals additions, deletions, and changed files', () => {
  const out = [
    '12\t3\tsrc/a.js',
    '0\t7\tsrc/b.js',
    '5\t0\tsrc/c.js',
  ].join('\n');
  assert.deepEqual(sumNumstat(out), { additions: 17, deletions: 10, files: 3 });
});

test('sumNumstat: a binary file counts as a changed file with 0 lines', () => {
  const out = ['10\t2\ttext.js', '-\t-\timg.png'].join('\n');
  assert.deepEqual(sumNumstat(out), { additions: 10, deletions: 2, files: 2 });
});

test('sumNumstat: blank lines and trailing newline are ignored', () => {
  assert.deepEqual(sumNumstat('\n4\t1\ta.js\n\n'), { additions: 4, deletions: 1, files: 1 });
});

test('sumNumstat: empty input is no change', () => {
  assert.deepEqual(sumNumstat(''), { additions: 0, deletions: 0, files: 0 });
});
