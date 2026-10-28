import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionBusy, reconcileArchived } from '../src/renderer/shared/session-archive.js';

test('busy states are the ones still doing something', () => {
  for (const s of ['working', 'bg-agents', 'needs-input']) assert.equal(isSessionBusy(s), true);
  for (const s of ['idle', 'completed', 'pushed', 'interrupted', undefined]) assert.equal(isSessionBusy(s), false);
});

test('with no local change in flight, main wins', () => {
  assert.deepEqual(reconcileArchived(true, undefined, false), { archived: false, pending: undefined });
  assert.deepEqual(reconcileArchived(false, undefined, true), { archived: true, pending: undefined });
});

test('a stale push does not undo a just-clicked archive', () => {
  assert.deepEqual(reconcileArchived(true, true, false), { archived: true, pending: true });
});

test('a stale push does not undo a just-clicked restore', () => {
  assert.deepEqual(reconcileArchived(false, false, true), { archived: false, pending: false });
});

test('main confirming the change clears the pending flag', () => {
  assert.deepEqual(reconcileArchived(true, true, true), { archived: true, pending: undefined });
});
