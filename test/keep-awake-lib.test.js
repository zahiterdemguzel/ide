const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeepAwake } = require('../src/main/keep-awake-lib');

function setup() {
  const calls = { started: 0, stopped: [] };
  const keepAwake = createKeepAwake({
    startBlocker: () => { calls.started++; return 7; },
    stopBlocker: (id) => calls.stopped.push(id),
  });
  return { calls, keepAwake };
}

test('holds while any reason is active and releases when the last one ends', () => {
  const { calls, keepAwake } = setup();
  keepAwake.setReason('a', true);
  keepAwake.setReason('b', true);
  assert.equal(calls.started, 1);
  keepAwake.setReason('a', false);
  assert.equal(keepAwake.isHolding(), true);
  keepAwake.setReason('b', false);
  assert.equal(keepAwake.isHolding(), false);
  assert.deepEqual(calls.stopped, [7]);
});

test('repeating the same reason does not start a second blocker', () => {
  const { calls, keepAwake } = setup();
  keepAwake.setReason('a', true);
  keepAwake.setReason('a', true);
  assert.equal(calls.started, 1);
});

test('deactivating an unknown reason is a no-op', () => {
  const { calls, keepAwake } = setup();
  keepAwake.setReason('ghost', false);
  assert.equal(calls.started, 0);
  assert.deepEqual(calls.stopped, []);
});
