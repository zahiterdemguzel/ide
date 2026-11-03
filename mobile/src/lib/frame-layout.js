// How a remote screen (the Control tab) should react to its frame area changing
// size. Plain JS so the node:test suite can import it — see
// test/mobile-frame-layout.test.mjs.
//
// The soft keyboard is the trap: Android resizes the window when it opens (and the
// Control tab pads itself above the keyboard on iOS), so the frame area gets
// shorter for as long as the user types. Treating that as a real resize reset the
// zoom and re-sent `control-open` on every keystroke session. A change that only
// shortens/lengthens the area while the keyboard is up is transient; a width change
// (rotation, split screen) is always real.

// Layout sizes jitter by fractions of a point between passes.
export const LAYOUT_EPSILON = 2;

/**
 * @param {{ w: number, h: number } | null} stable  the last size acted on
 * @param {{ w: number, h: number }} next            the size just laid out
 * @param {boolean} keyboardVisible
 * @returns {'none' | 'keyboard' | 'resize'}
 */
export function classifyLayoutChange(stable, next, keyboardVisible) {
  if (!stable || !stable.w || !stable.h) return 'resize';
  const sameWidth = Math.abs(next.w - stable.w) <= LAYOUT_EPSILON;
  const sameHeight = Math.abs(next.h - stable.h) <= LAYOUT_EPSILON;
  if (sameWidth && sameHeight) return 'none';
  if (keyboardVisible && sameWidth) return 'keyboard';
  return 'resize';
}
