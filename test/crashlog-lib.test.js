'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { crashLogName, formatCrash } = require('../src/main/crashlog-lib');

const WHEN = new Date('2026-06-27T12:34:56.789Z');

test('crashLogName: sortable, filesystem-safe (no : or .)', () => {
  const name = crashLogName(WHEN);
  assert.strictEqual(name, 'crash-2026-06-27T12-34-56-789Z.log');
  assert.ok(!/[:.]/.test(name.replace(/\.log$/, '')), 'no colons or dots in the stamp');
});

test('formatCrash: includes the kind, the time, and the stack', () => {
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at x';
  const body = formatCrash('uncaughtException', err, WHEN);
  assert.match(body, /=== uncaughtException ===/);
  assert.match(body, /Time: 2026-06-27T12:34:56\.789Z/);
  assert.match(body, /Error: boom\n {4}at x/);
});

test('formatCrash: falls back to String() when there is no stack', () => {
  const body = formatCrash('unhandledRejection', 'plain string reason', WHEN);
  assert.match(body, /plain string reason/);
});
