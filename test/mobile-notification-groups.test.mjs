// The phone's Notifications layout (mobile/src/lib/notification-groups.js): recency
// buckets, and packing read/unread alerts into whole cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketByRecency, packIntoCards, alertSections, alertTapAction,
} from '../mobile/src/lib/notification-groups.js';

const NOW = new Date(2026, 10, 2, 15, 0, 0).getTime();
const MIN = 60 * 1000;
const alert = (id, minutesAgo, unread = false) => ({ id, at: NOW - minutesAgo * MIN, unread });

test('bucketByRecency sorts newest first and splits by hour / today / older', () => {
  const list = [alert('old', 60 * 24), alert('a', 5), alert('b', 90), alert('c', 1)];
  const buckets = bucketByRecency(list, NOW);
  assert.deepEqual(buckets.map((b) => b.key), ['now', 'today', 'older']);
  assert.deepEqual(buckets[0].alerts.map((a) => a.id), ['c', 'a']);
  assert.deepEqual(buckets[1].alerts.map((a) => a.id), ['b']);
  assert.deepEqual(buckets[2].alerts.map((a) => a.id), ['old']);
});

test('bucketByRecency drops empty buckets', () => {
  assert.deepEqual(bucketByRecency([alert('a', 2)], NOW).map((b) => b.key), ['now']);
  assert.deepEqual(bucketByRecency([], NOW), []);
});

test('packIntoCards groups consecutive read alerts and isolates unread ones', () => {
  const list = [
    alert('r1', 1), alert('r2', 2),
    alert('u1', 3, true),
    alert('r3', 4),
    alert('u2', 5, true), alert('u3', 6, true),
    alert('r4', 7), alert('r5', 8),
  ];
  const blocks = packIntoCards(list);
  assert.deepEqual(
    blocks.map((b) => [b.unread, b.alerts.map((a) => a.id)]),
    [
      [false, ['r1', 'r2']],
      [true, ['u1']],
      [false, ['r3']],
      [true, ['u2']],
      [true, ['u3']],
      [false, ['r4', 'r5']],
    ],
  );
  // Keys are stable and unique: the first alert's id.
  assert.deepEqual(blocks.map((b) => b.key), ['r1', 'u1', 'r3', 'u2', 'u3', 'r4']);
});

test('packIntoCards keeps every alert exactly once and in order', () => {
  const list = [alert('a', 1, true), alert('b', 2), alert('c', 3, true), alert('d', 4)];
  const flat = packIntoCards(list).flatMap((b) => b.alerts.map((a) => a.id));
  assert.deepEqual(flat, ['a', 'b', 'c', 'd']);
});

test('alertSections packs each bucket separately', () => {
  // Two read alerts in different buckets must not share a card.
  const sections = alertSections([alert('now', 1), alert('today', 120)], NOW);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => s.data.length), [1, 1]);
});

test('alertTapAction opens the session, else expands a detail, else does nothing', () => {
  assert.equal(alertTapAction({ sessionId: 's1', detail: 'x' }), 'session');
  assert.equal(alertTapAction({ sessionId: null, detail: 'stderr…' }), 'expand');
  assert.equal(alertTapAction({ sessionId: null, detail: '  ' }), 'none');
  assert.equal(alertTapAction({ sessionId: null, detail: '' }), 'none');
});
