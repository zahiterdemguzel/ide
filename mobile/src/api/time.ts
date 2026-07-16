// Relative time for a session row, in the shape the design uses: a couple of
// characters ("2m", "14m", "3h", "6d") rather than prose, because it sits at the
// end of a row next to a name that deserves the width.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// `at` is a ms epoch, or 0 for "unknown" — a session persisted before the app
// recorded timestamps. That renders as no label at all, which is honest; a session
// dated 1970 or "56y" would not be.
export function shortAgo(at: number, now: number = Date.now()): string {
  if (!at) return '';
  const ms = Math.max(0, now - at);
  if (ms < MIN) return 'now';
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}
