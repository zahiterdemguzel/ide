// Pure, DOM-free logic for the first-time-user onboarding (the guided tour and
// keyboard cheat sheet). Kept Electron- and DOM-free so it is unit tested in
// isolation; the renderer modules in src/renderer/onboarding/ are the thin glue
// that feed it real element rects.

// The guided tour, in order. `target` is a CSS selector resolved at run time; a
// step whose target is missing or hidden (e.g. a panel toggled off) is skipped.
export const TOUR_STEPS = [
  { id: 'toolbar', target: '#toolbar', titleKey: 'tour.toolbar.title', bodyKey: 'tour.toolbar.body' },
  { id: 'sessions', target: '#sessions-pane', titleKey: 'tour.sessions.title', bodyKey: 'tour.sessions.body' },
  { id: 'explorer', target: '#files-pane', titleKey: 'tour.explorer.title', bodyKey: 'tour.explorer.body' },
  { id: 'terminal', target: '#center', titleKey: 'tour.terminal.title', bodyKey: 'tour.terminal.body' },
  { id: 'git', target: '#git-main', titleKey: 'tour.git.title', bodyKey: 'tour.git.body' },
  { id: 'console', target: '#git-console', titleKey: 'tour.console.title', bodyKey: 'tour.console.body' },
  { id: 'settings', target: '#settings-btn', titleKey: 'tour.settings.title', bodyKey: 'tour.settings.body' },
];

const MARGIN = 10;
const TAIL_INSET = 14;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(value, hi));
}

// Position a callout bubble relative to an anchor's bounding rect. Prefer above
// the anchor (tail pointing down), flip below when there's no room above; but for
// a tall target where neither above nor below fits the viewport (e.g. the
// full-height session terminal) fall back to a side placement, preferring the
// left so the bubble lands beside the target rather than off-screen. The bubble
// is always clamped to the viewport, and the tail tracks the anchor centre even
// after clamping. All inputs are plain rects ({ top,left,width,height,bottom }),
// so this is fully testable without a DOM. Returns `placement`
// ('top'|'bottom'|'left'|'right') and, for back-compat, `below` (true only for
// 'bottom'); `tail` is a horizontal offset for top/bottom and a vertical offset
// for left/right.
export function placeBubble(anchorRect, bubbleSize, viewport) {
  const bottom = anchorRect.bottom ?? anchorRect.top + anchorRect.height;
  const cx = anchorRect.left + anchorRect.width / 2;
  const cy = anchorRect.top + anchorRect.height / 2;

  const aboveTop = anchorRect.top - bubbleSize.height - MARGIN;
  const belowTop = bottom + MARGIN;
  const fitsAbove = aboveTop >= MARGIN;
  const fitsBelow = belowTop + bubbleSize.height <= viewport.height - MARGIN;

  if (fitsAbove || fitsBelow) {
    const below = !fitsAbove; // prefer above; only drop below when above won't fit
    const maxLeft = Math.max(MARGIN, viewport.width - bubbleSize.width - MARGIN);
    const left = clamp(cx - bubbleSize.width / 2, MARGIN, maxLeft);
    const top = below ? belowTop : aboveTop;
    const tail = clamp(cx - left, TAIL_INSET, Math.max(TAIL_INSET, bubbleSize.width - TAIL_INSET));
    return {
      placement: below ? 'bottom' : 'top', below,
      left: Math.round(left), top: Math.round(top), tail: Math.round(tail),
    };
  }

  // Neither above nor below fits — place beside the anchor, preferring the left.
  const leftSideLeft = anchorRect.left - bubbleSize.width - MARGIN;
  const placement = leftSideLeft >= MARGIN ? 'left' : 'right';
  const rawLeft = placement === 'left' ? leftSideLeft : anchorRect.left + anchorRect.width + MARGIN;
  const maxLeft = Math.max(MARGIN, viewport.width - bubbleSize.width - MARGIN);
  const left = clamp(rawLeft, MARGIN, maxLeft);
  const maxTop = Math.max(MARGIN, viewport.height - bubbleSize.height - MARGIN);
  const top = clamp(cy - bubbleSize.height / 2, MARGIN, maxTop);
  const tail = clamp(cy - top, TAIL_INSET, Math.max(TAIL_INSET, bubbleSize.height - TAIL_INSET));
  return { placement, below: false, left: Math.round(left), top: Math.round(top), tail: Math.round(tail) };
}
