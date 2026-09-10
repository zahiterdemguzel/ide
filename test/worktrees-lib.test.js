const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  WORKTREES_REL, worktreeName, branchNameFor, worktreesRoot, worktreePath,
  branchSlug, titledBranchFor, parseWorktreeList,
  isUnder, copyRoots, applySkipList, prescanRows, isMergeConflict, removeVerdict,
} = require('../src/main/worktrees-lib');

const ID = '9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8';

// --- naming ---

test('worktreeName: derived from the session id, stable and path-safe', () => {
  assert.equal(worktreeName(ID), 'sess-9f1c2b3a');
  assert.equal(worktreeName(ID), worktreeName(ID));
  assert.match(worktreeName(ID), /^[a-z0-9-]+$/);
});

test('worktreeName: survives a missing or short id', () => {
  assert.equal(worktreeName(''), 'sess-unknown');
  assert.equal(worktreeName(null), 'sess-unknown');
  assert.equal(worktreeName('ab'), 'sess-ab');
});

test('branchNameFor: namespaced under ide/ so project branches are never shadowed', () => {
  assert.equal(branchNameFor(ID), 'ide/sess-9f1c2b3a');
});

test('worktreePath: lands inside the project .claude/worktrees', () => {
  const root = worktreesRoot('/proj');
  assert.equal(root, path.join('/proj', ...WORKTREES_REL.split('/')));
  assert.equal(worktreePath('/proj', ID), path.join(root, 'sess-9f1c2b3a'));
});

// --- branch slugs from session titles ---

test('branchSlug: lowercases and hyphenates a title', () => {
  assert.equal(branchSlug('Add Worktree Support'), 'add-worktree-support');
  assert.equal(branchSlug('  Fix   the parser  '), 'fix-the-parser');
});

test('branchSlug: strips characters git refuses in a ref', () => {
  assert.equal(branchSlug('fix: a~b^c:d?e*f[g'), 'fix-a-b-c-d-e-f-g');
  assert.equal(branchSlug("don't break \"quotes\""), 'dont-break-quotes');
  assert.equal(branchSlug('a..b'), 'a-b');
});

test('branchSlug: no leading/trailing dot, hyphen or slash', () => {
  assert.equal(branchSlug('...leading'), 'leading');
  assert.equal(branchSlug('trailing...'), 'trailing');
  assert.equal(branchSlug('-edges-'), 'edges');
});

test('branchSlug: caps length', () => {
  assert.ok(branchSlug('x'.repeat(200)).length <= 40);
});

test('branchSlug: returns empty when nothing usable survives', () => {
  assert.equal(branchSlug(''), '');
  assert.equal(branchSlug('***'), '');
  assert.equal(branchSlug('日本語'), '');
  assert.equal(branchSlug('.lock'), '');
});

test('titledBranchFor: keeps an id suffix so identical titles cannot collide', () => {
  const a = titledBranchFor(ID, 'Add worktree support');
  assert.equal(a, 'ide/add-worktree-support-2b3a');
  assert.notEqual(a, titledBranchFor('11112222-3333', 'Add worktree support'));
});

test('titledBranchFor: empty when the title yields no slug, so the id name stays', () => {
  assert.equal(titledBranchFor(ID, '***'), '');
});

// --- git worktree list --porcelain ---

test('parseWorktreeList: main tree plus linked worktrees', () => {
  const out = parseWorktreeList([
    'worktree /proj',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /proj/.claude/worktrees/sess-9f1c2b3a',
    'HEAD def456',
    'branch refs/heads/ide/sess-9f1c2b3a',
    '',
  ].join('\n'));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((w) => w.branch), ['main', 'ide/sess-9f1c2b3a']);
  assert.equal(out[1].path, '/proj/.claude/worktrees/sess-9f1c2b3a');
});

test('parseWorktreeList: detached, locked and prunable flags', () => {
  const out = parseWorktreeList([
    'worktree /a', 'HEAD abc', 'detached', '',
    'worktree /b', 'HEAD def', 'branch refs/heads/x', 'locked', '',
    'worktree /c', 'HEAD ghi', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'));
  assert.equal(out[0].detached, true);
  assert.equal(out[0].branch, '');
  assert.equal(out[1].locked, true);
  assert.equal(out[2].prunable, true);
});

test('parseWorktreeList: tolerates CRLF, a missing trailing blank line and junk', () => {
  const out = parseWorktreeList('worktree /a\r\nHEAD abc\r\nbranch refs/heads/main\r\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].branch, 'main');
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList('HEAD abc\nbranch refs/heads/x'), []);
});

test('parseWorktreeList: keeps paths containing spaces intact', () => {
  const out = parseWorktreeList('worktree /My Projects/app\nHEAD abc\n');
  assert.equal(out[0].path, '/My Projects/app');
});

// --- what the seeding copy carries ---

const STATUS = [
  ' M src/tracked.js',
  'A  src/staged.js',
  '?? .env',
  '?? src/notes.txt',
  '!! node_modules/',
  '!! dist/',
  '!! .git/hooks/local',
  '!! .claude/worktrees/',
  '?? .claude/worktrees/sess-aaaa/scratch.txt',
].join('\n');

test('copyRoots: takes untracked and ignored entries only', () => {
  const roots = copyRoots(STATUS).map((r) => r.path);
  assert.deepEqual(roots, ['.env', 'src/notes.txt', 'node_modules', 'dist']);
});

// Tracked files are already materialized by `git worktree add`; copying them
// would overwrite the checkout with the main tree's uncommitted state.
test('copyRoots: never includes tracked paths', () => {
  const roots = copyRoots(STATUS).map((r) => r.path);
  assert.ok(!roots.includes('src/tracked.js'));
  assert.ok(!roots.includes('src/staged.js'));
});

test('copyRoots: never includes .git or the worktrees directory', () => {
  const roots = copyRoots(STATUS).map((r) => r.path);
  assert.ok(!roots.some((p) => p.startsWith('.git')));
  assert.ok(!roots.some((p) => p.includes('worktrees')));
});

test('copyRoots: marks ignored vs untracked and directory rows', () => {
  const byPath = Object.fromEntries(copyRoots(STATUS).map((r) => [r.path, r]));
  assert.equal(byPath['node_modules'].ignored, true);
  assert.equal(byPath['node_modules'].dir, true);
  assert.equal(byPath['.env'].ignored, false);
  assert.equal(byPath['.env'].dir, false);
});

test('copyRoots: keeps non-ASCII and spaced paths verbatim (core.quotePath=false)', () => {
  const roots = copyRoots('?? src/é hôtel.txt\n?? "quoted path.txt"').map((r) => r.path);
  assert.deepEqual(roots, ['src/é hôtel.txt', 'quoted path.txt']);
});

test('copyRoots: de-duplicates and ignores short or empty lines', () => {
  assert.deepEqual(copyRoots('?? a\n?? a\n\n??\nx').map((r) => r.path), ['a']);
});

test('applySkipList: drops a skipped root and anything nested under it', () => {
  const roots = copyRoots('?? node_modules/\n?? node_modules/.cache\n?? .env');
  const kept = applySkipList(roots, ['node_modules']).map((r) => r.path);
  assert.deepEqual(kept, ['.env']);
});

test('applySkipList: an empty skip list keeps everything, and never mutates', () => {
  const roots = copyRoots('?? a\n?? b');
  const kept = applySkipList(roots, []);
  assert.deepEqual(kept.map((r) => r.path), ['a', 'b']);
  assert.notEqual(kept, roots);
});

test('applySkipList: a trailing slash in the skip list still matches', () => {
  const roots = copyRoots('?? node_modules/\n?? .env');
  assert.deepEqual(applySkipList(roots, ['node_modules/']).map((r) => r.path), ['.env']);
});

test('isUnder: prefix match is path-segment aware', () => {
  assert.equal(isUnder('node_modules/x', 'node_modules'), true);
  assert.equal(isUnder('node_modules', 'node_modules'), true);
  assert.equal(isUnder('node_modules_backup', 'node_modules'), false);
});

test('prescanRows: heaviest first, small entries left out of the dialog', () => {
  const rows = prescanRows([
    { path: 'a', bytes: 6e6 },
    { path: 'big', bytes: 2e9 },
    { path: 'tiny', bytes: 1000 },
  ]);
  assert.deepEqual(rows.map((r) => r.path), ['big', 'a']);
});

// --- merge + removal verdicts ---

test('isMergeConflict: recognizes git conflict wording', () => {
  assert.equal(isMergeConflict('CONFLICT (content): Merge conflict in src/a.js'), true);
  assert.equal(isMergeConflict('Automatic merge failed; fix conflicts and then commit the result.'), true);
  assert.equal(isMergeConflict('error: could not apply abc123'), true);
});

// A lock/auth/checkout failure is a different problem with a different fix —
// offering "let Claude resolve the conflict" for it would be nonsense.
test('isMergeConflict: does not fire on unrelated git failures', () => {
  assert.equal(isMergeConflict('fatal: Unable to create index.lock: File exists'), false);
  assert.equal(isMergeConflict('Permission denied (publickey)'), false);
  assert.equal(isMergeConflict(''), false);
});

test('removeVerdict: a live process in the tree is a hard stop', () => {
  assert.deepEqual(removeVerdict({ live: true, dirty: true }), { allow: false, reason: 'live' });
});

test('removeVerdict: recoverable states warn but are allowed', () => {
  assert.deepEqual(removeVerdict({ dirty: true, unmerged: 2 }),
    { allow: true, reason: 'dirty', warn: ['dirty', 'unmerged'] });
  assert.deepEqual(removeVerdict({ unpushed: 1 }),
    { allow: true, reason: 'unpushed', warn: ['unpushed'] });
});

test('removeVerdict: a clean merged worktree removes with no warning', () => {
  assert.deepEqual(removeVerdict({}), { allow: true, reason: '', warn: [] });
});
