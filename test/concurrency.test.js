const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../src/main/concurrency');

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
