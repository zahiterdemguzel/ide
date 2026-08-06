const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, createCoalescer } = require('../src/main/concurrency');

test('never runs more than max at once and completes everything', async () => {
  const limit = createLimiter(2);
  let active = 0, peak = 0;
  const task = () => {
    active++;
    peak = Math.max(peak, active);
    return new Promise((r) => setImmediate(() => { active--; r('done'); }));
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => limit(task)));
  assert.equal(peak, 2);
  assert.deepEqual(results, Array(8).fill('done'));
});

test('resolves with each task\'s own value in submission order', async () => {
  const limit = createLimiter(1);
  const order = [];
  const results = await Promise.all([1, 2, 3].map((n) => limit(async () => { order.push(n); return n * 10; })));
  assert.deepEqual(order, [1, 2, 3]); // FIFO: queued order is run order
  assert.deepEqual(results, [10, 20, 30]);
});

test('a rejection reaches the caller and frees the slot', async () => {
  const limit = createLimiter(1);
  const failed = limit(async () => { throw new Error('boom'); });
  await assert.rejects(failed, /boom/);
  assert.equal(await limit(async () => 'still works'), 'still works');
});

test('a synchronous throw inside fn rejects instead of breaking the queue', async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit(() => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(await limit(() => 'ok'), 'ok');
});

// The repo-write mutex (git.js `repoWrite`) is createLimiter(1). What it must
// guarantee for the per-session commit buttons: a task that awaits several times
// (read HEAD → author a message → write HEAD) never interleaves with another, so
// two sessions committing at once can't both build on the same HEAD.
test('max 1 keeps multi-await tasks from interleaving', async () => {
  const limit = createLimiter(1);
  const log = [];
  const commit = async (name) => {
    log.push(`${name}:read`);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r)); // stands in for the message call
    log.push(`${name}:write`);
  };
  await Promise.all(['a', 'b', 'c'].map((n) => limit(() => commit(n))));
  assert.deepEqual(log, ['a:read', 'a:write', 'b:read', 'b:write', 'c:read', 'c:write']);
});

test('coalescer: a burst of callers shares runs instead of one run each', async () => {
  let runs = 0;
  const scan = createCoalescer(async () => { runs++; await new Promise((r) => setImmediate(r)); return runs; });
  const results = await Promise.all(Array.from({ length: 6 }, () => scan()));
  assert.equal(runs, 1); // all six arrived before the first run started
  assert.deepEqual(results, [1, 1, 1, 1, 1, 1]);
});

test('coalescer: a caller arriving mid-run gets a run started AFTER its call', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let runs = 0;
  const scan = createCoalescer(async () => { runs++; const n = runs; if (n === 1) await gate; return n; });
  const first = scan();
  await new Promise((r) => setImmediate(r)); // run 1 is now in flight
  const second = scan(); // must NOT be served by run 1 — its state predates the call
  const third = scan();  // shares run 2 with `second`
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.equal(await third, 2);
  assert.equal(runs, 2);
});

test('coalescer: a failed run does not wedge later calls', async () => {
  let runs = 0;
  const scan = createCoalescer(async () => { runs++; if (runs === 1) throw new Error('boom'); return runs; });
  await assert.rejects(scan(), /boom/);
  assert.equal(await scan(), 2);
});
