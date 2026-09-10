const test = require('node:test');
const assert = require('node:assert');
const { isNoiseEvent, settleTarget, sameTree } = require('../src/main/fs-watch-lib');

test('isNoiseEvent filters git internals', () => {
  // The loud one: every git command the tracker itself runs rewrites these, so an
  // unfiltered watcher would fire on its own activity forever.
  assert.strictEqual(isNoiseEvent('.git/index'), true);
  assert.strictEqual(isNoiseEvent('.git\\refs\\heads\\master'), true);
  assert.strictEqual(isNoiseEvent('sub/.git/index'), true);
});

test('isNoiseEvent filters dependency and build output', () => {
  assert.strictEqual(isNoiseEvent('node_modules/foo/index.js'), true);
  assert.strictEqual(isNoiseEvent('dist/bundle.js'), true);
  assert.strictEqual(isNoiseEvent('__pycache__/mod.pyc'), true);
});

test('isNoiseEvent keeps real source changes', () => {
  assert.strictEqual(isNoiseEvent('src/main/sessions.js'), false);
  assert.strictEqual(isNoiseEvent('README.md'), false);
  // Only DIRECTORY segments are judged — a file named like a build dir stays.
  assert.strictEqual(isNoiseEvent('src/dist.js'), false);
  assert.strictEqual(isNoiseEvent('.github/workflows/ci.yml'), false);
});

test('isNoiseEvent treats a missing name as noise', () => {
  // Some platforms report an event with no filename; there is nothing to judge.
  assert.strictEqual(isNoiseEvent(''), true);
  assert.strictEqual(isNoiseEvent(null), true);
});

const entry = (over) => ({ id: 'a', repo: '/repo', working: false, hasBaseline: true, turnEndedAt: 100, ...over });

test('settleTarget picks the most recently finished session', () => {
  const got = settleTarget([
    entry({ id: 'old', turnEndedAt: 100 }),
    entry({ id: 'new', turnEndedAt: 200 }),
  ]);
  assert.strictEqual(got.id, 'new');
});

test('settleTarget skips sessions in another tree', () => {
  const got = settleTarget([entry({ id: 'elsewhere', repo: null, turnEndedAt: 999 }), entry({ id: 'here' })]);
  assert.strictEqual(got.id, 'here');
});

test('settleTarget skips a session still working', () => {
  // Its own tool/turn windows are already holding a baseline for this change;
  // settling underneath them would diff it twice.
  const got = settleTarget([entry({ id: 'busy', working: true, turnEndedAt: 999 }), entry({ id: 'idle' })]);
  assert.strictEqual(got.id, 'idle');
});

test('settleTarget skips a session with no baseline', () => {
  const got = settleTarget([entry({ id: 'nobase', hasBaseline: false, turnEndedAt: 999 }), entry({ id: 'ok' })]);
  assert.strictEqual(got.id, 'ok');
});

test('settleTarget picks nobody on a tie', () => {
  // Attribution here is a guess; handing one change to two sessions would put
  // the same file in both their commits.
  assert.strictEqual(settleTarget([entry({ id: 'a' }), entry({ id: 'b' })]), null);
});

test('settleTarget picks nobody when nothing qualifies', () => {
  assert.strictEqual(settleTarget([]), null);
  assert.strictEqual(settleTarget([entry({ working: true })]), null);
});

test('sameTree compares resolved paths', () => {
  assert.strictEqual(sameTree('/repo', '/repo/'), true);
  assert.strictEqual(sameTree('/repo/sub/..', '/repo'), true);
  // A worktree is not the project it was cut from.
  assert.strictEqual(sameTree('/repo', '/repo/../wt'), false);
  assert.strictEqual(sameTree('', '/repo'), false);
});
