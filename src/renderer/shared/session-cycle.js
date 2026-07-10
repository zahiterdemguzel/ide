console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/session-cycle.js'); // PERF-TEMP
// Pure, DOM-free helper for keyboard session cycling (Ctrl+Tab / Ctrl+Shift+Tab).
// Given the ordered ids of the currently-visible session rows and the active id,
// return the id to switch to. `dir` 1 = next, -1 = previous; both wrap around the
// ends so cycling past the last row lands back on the first. Returns null when
// there is nowhere to go (no rows, or the move would land on the active row) so
// the caller can no-op instead of redundantly re-selecting.
export function nextSessionId(orderedIds, activeId, dir = 1) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return null;
  const n = orderedIds.length;
  const i = orderedIds.indexOf(activeId);
  // Active row isn't in the visible set (e.g. nothing selected yet): jump to the
  // first row going forward, the last going backward.
  if (i === -1) return orderedIds[dir > 0 ? 0 : n - 1];
  const j = (((i + dir) % n) + n) % n;
  const id = orderedIds[j];
  return id === activeId ? null : id; // single visible row → stay put
}
