import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastKind, countByKind, broadcastTargetIds } from '../src/renderer/shared/session-broadcast.js';

const list = [
  { id: 'done', repo: '/r', archived: false, state: 'completed' },
  { id: 'fresh', repo: '/r', archived: false, state: 'idle' },
  { id: 'running', repo: '/r', archived: false, state: 'working' },
  { id: 'agents', repo: '/r', archived: false, state: 'bg-agents' },
  { id: 'asking', repo: '/r', archived: false, state: 'needs-input' },
  { id: 'cut', repo: '/r', archived: false, state: 'interrupted' },
  { id: 'gone', repo: '/r', archived: true, state: 'idle' },
  { id: 'elsewhere', repo: '/other', archived: false, state: 'idle' },
];

test('settled states group as idle, background agents as working', () => {
  for (const s of ['idle', 'completed', 'pushed', undefined]) assert.equal(broadcastKind(s), 'idle');
  assert.equal(broadcastKind('bg-agents'), 'working');
  assert.equal(broadcastKind('needs-input'), 'needs-input');
  assert.equal(broadcastKind('interrupted'), 'interrupted');
});

test('counts only active sessions of the open project', () => {
  assert.deepEqual(countByKind(list, '/r'), { idle: 2, working: 2, 'needs-input': 1, interrupted: 1 });
});

test('targets follow the ticked kinds and skip archived / other-project sessions', () => {
  assert.deepEqual(broadcastTargetIds(list, '/r', ['idle', 'interrupted']), ['done', 'fresh', 'cut']);
  assert.deepEqual(broadcastTargetIds(list, '/r', []), []);
  assert.deepEqual(broadcastTargetIds(list, undefined, ['idle']), ['done', 'fresh', 'elsewhere']);
});
