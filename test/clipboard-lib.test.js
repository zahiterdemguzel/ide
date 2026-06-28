'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { withClipboardRetry } = require('../src/main/clipboard-lib');

const noSleep = () => Promise.resolve();

test('returns the result on first success without sleeping', async () => {
  let sleeps = 0;
  const out = await withClipboardRetry(() => 'hello', { sleep: () => { sleeps++; return Promise.resolve(); } });
  assert.strictEqual(out, 'hello');
  assert.strictEqual(sleeps, 0);
});

test('retries a transient throw, then succeeds (the Windows clipboard-lock case)', async () => {
  let calls = 0;
  const out = await withClipboardRetry(() => {
    calls++;
    if (calls < 3) throw new Error('OpenClipboard failed');
    return 'text';
  }, { sleep: noSleep });
  assert.strictEqual(out, 'text');
  assert.strictEqual(calls, 3);
});

test('gives up after `attempts` throws and returns the fallback value', async () => {
  let calls = 0;
  const out = await withClipboardRetry(() => { calls++; throw new Error('locked'); },
    { attempts: 4, sleep: noSleep, fallback: '' });
  assert.strictEqual(out, '');
  assert.strictEqual(calls, 4);
});

test('a function fallback receives the last error', async () => {
  const out = await withClipboardRetry(() => { throw new Error('boom'); },
    { attempts: 2, sleep: noSleep, fallback: (e) => ({ ok: false, error: e.message }) });
  assert.deepStrictEqual(out, { ok: false, error: 'boom' });
});

test('sleeps between attempts but not after the last one', async () => {
  let sleeps = 0;
  await withClipboardRetry(() => { throw new Error('x'); },
    { attempts: 3, sleep: () => { sleeps++; return Promise.resolve(); } });
  assert.strictEqual(sleeps, 2); // 3 attempts → 2 gaps
});
