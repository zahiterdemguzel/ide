const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPtyBatcher } = require('../src/main/pty-batch');

// Manual scheduler: timers fire only when the test calls tick().
function makeScheduler() {
  let nextId = 1;
  const timers = new Map(); // id -> fn
  return {
    setTimer: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    tick: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    pendingCount: () => timers.size,
  };
}

function makeBatcher() {
  const sched = makeScheduler();
  const flushed = [];
  const batch = createPtyBatcher((id, data) => flushed.push([id, data]), sched);
  return { sched, flushed, batch };
}

test('coalesces a burst into one flush, preserving order', () => {
  const { sched, flushed, batch } = makeBatcher();
  batch.push('a', 'one ');
  batch.push('a', 'two ');
  batch.push('a', 'three');
  assert.deepEqual(flushed, []); // nothing until the timer fires
  sched.tick();
  assert.deepEqual(flushed, [['a', 'one two three']]);
});

test('ids buffer and flush independently', () => {
  const { sched, flushed, batch } = makeBatcher();
  batch.push('a', 'A1');
  batch.push('b', 'B1');
  batch.push('a', 'A2');
  sched.tick();
  assert.deepEqual(flushed.sort(), [['a', 'A1A2'], ['b', 'B1']]);
});

test('flushId drains the tail immediately and cancels the timer', () => {
  const { sched, flushed, batch } = makeBatcher();
  batch.push('a', 'tail');
  batch.flushId('a');
  assert.deepEqual(flushed, [['a', 'tail']]);
  assert.equal(sched.pendingCount(), 0); // timer cancelled
  sched.tick();
  assert.deepEqual(flushed, [['a', 'tail']]); // no double flush
  batch.flushId('a'); // nothing pending: a no-op
  assert.deepEqual(flushed, [['a', 'tail']]);
});

test('a new push after a flush starts a fresh batch', () => {
  const { sched, flushed, batch } = makeBatcher();
  batch.push('a', 'first');
  sched.tick();
  batch.push('a', 'second');
  sched.tick();
  assert.deepEqual(flushed, [['a', 'first'], ['a', 'second']]);
});
