// Pure layout of the Notifications list: which time bucket each alert falls in, and
// how the alerts inside a bucket are packed into cards. Plain JS rather than
// TypeScript so the repo's node:test suite can import it — see
// test/mobile-notification-groups.test.mjs.
//
// The packing is the part that used to break. An unread alert gets a card of its own
// (its glow can't be drawn on a row inside a shared border), and read alerts share one
// card with hairlines between them. Alerts are sorted by time, so unread and read ones
// interleave — and deciding a row's top/bottom border from its index in the bucket
// gave a read row squeezed between two unread ones neither edge. So the list is packed
// into *blocks* first: each run of consecutive read alerts is one block, each unread
// alert is its own, and every block renders as exactly one whole card.

const HOUR_MS = 60 * 60 * 1000;

/**
 * @typedef {{ id: string, at: number, unread: boolean }} AlertLike
 */

/**
 * @template {AlertLike} A
 * @typedef {{ key: string, unread: boolean, alerts: A[] }} AlertBlock
 */

/**
 * @template {AlertLike} A
 * @typedef {{ key: string, label: string, data: AlertBlock<A>[] }} AlertSection
 */

/**
 * Split alerts into the design's recency buckets, newest first. An alert older than
 * today lands in a third bucket rather than being dropped — an interrupted session
 * from yesterday is still worth seeing. Empty buckets are left out.
 *
 * @template {AlertLike} A
 * @param {A[]} list
 * @param {number} now ms epoch
 * @returns {{ key: string, label: string, alerts: A[] }[]}
 */
export function bucketByRecency(list, now) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  /** @type {{ key: string, label: string, alerts: A[] }[]} */
  const buckets = [
    { key: 'now', label: 'Just now', alerts: [] },
    { key: 'today', label: 'Earlier today', alerts: [] },
    { key: 'older', label: 'Older', alerts: [] },
  ];
  for (const a of [...list].sort((x, y) => y.at - x.at)) {
    const index = now - a.at < HOUR_MS ? 0 : a.at >= midnight ? 1 : 2;
    buckets[index].alerts.push(a);
  }
  return buckets.filter((b) => b.alerts.length > 0);
}

/**
 * Pack an ordered run of alerts into cards: every unread alert alone, every run of
 * consecutive read alerts together. Order is preserved.
 *
 * @template {AlertLike} A
 * @param {A[]} alerts
 * @returns {AlertBlock<A>[]}
 */
export function packIntoCards(alerts) {
  /** @type {AlertBlock<A>[]} */
  const blocks = [];
  for (const a of alerts) {
    const previous = blocks[blocks.length - 1];
    if (!a.unread && previous && !previous.unread) {
      previous.alerts.push(a);
    } else {
      blocks.push({ key: a.id, unread: a.unread, alerts: [a] });
    }
  }
  return blocks;
}

/**
 * The SectionList's sections: one per recency bucket, each holding cards.
 *
 * @template {AlertLike} A
 * @param {A[]} list
 * @param {number} [now] ms epoch
 * @returns {AlertSection<A>[]}
 */
export function alertSections(list, now = Date.now()) {
  return bucketByRecency(list, now).map((b) => ({
    key: b.key,
    label: b.label,
    data: packIntoCards(b.alerts),
  }));
}

/**
 * What tapping an alert does: open the session it came from, or — with no session to
 * go to — expand it in place so the whole message can be read and copied. An alert
 * with neither (no session, no detail) does nothing.
 *
 * @param {{ sessionId: string | null, detail: string }} alert
 * @returns {'session' | 'expand' | 'none'}
 */
export function alertTapAction(alert) {
  if (alert.sessionId) return 'session';
  if (alert.detail && alert.detail.trim()) return 'expand';
  return 'none';
}
