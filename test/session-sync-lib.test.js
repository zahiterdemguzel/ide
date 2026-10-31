const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fileStamp, planFileChange, idsToWriteOnQuit } = require('../src/main/session-sync-lib');

test('fileStamp: mtime and size identify a file version; no stat is null', () => {
  assert.equal(fileStamp({ mtimeMs: 1700000000123.5, size: 42 }), '1700000000123.5:42');
  assert.equal(fileStamp(null), null);
});

test('planFileChange: our own write echoing back is ignored', () => {
  assert.equal(planFileChange({ local: { live: false }, diskStamp: 'a', syncedStamp: 'a' }), 'ignore');
  // A file this instance never saw, still absent, is no change either.
  assert.equal(planFileChange({ local: { live: false }, diskStamp: null, syncedStamp: undefined }), 'ignore');
});

test('planFileChange: another instance archiving a stopped session is adopted', () => {
  assert.equal(planFileChange({ local: { live: false }, diskStamp: 'b', syncedStamp: 'a' }), 'adopt');
});

test('planFileChange: a session created by another instance is adopted', () => {
  assert.equal(planFileChange({ local: undefined, diskStamp: 'b', syncedStamp: undefined }), 'adopt');
});

test('planFileChange: a session deleted by another instance is dropped', () => {
  assert.equal(planFileChange({ local: { live: false }, diskStamp: null, syncedStamp: 'a' }), 'drop');
  assert.equal(planFileChange({ local: undefined, diskStamp: null, syncedStamp: 'a' }), 'ignore');
});

test('planFileChange: a session running here keeps its own record', () => {
  assert.equal(planFileChange({ local: { live: true }, diskStamp: 'b', syncedStamp: 'a' }), 'ignore');
  assert.equal(planFileChange({ local: { live: true }, diskStamp: null, syncedStamp: 'a' }), 'ignore');
});

test('idsToWriteOnQuit: only running sessions and pending writes, never stale stopped ones', () => {
  const entries = [
    { id: 'running', live: true, pendingWrite: false },
    { id: 'debounced', live: false, pendingWrite: true },
    { id: 'archived-elsewhere', live: false, pendingWrite: false },
  ];
  assert.deepEqual(idsToWriteOnQuit(entries), ['running', 'debounced']);
});
