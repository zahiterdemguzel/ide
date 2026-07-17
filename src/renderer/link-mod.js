// Shared Ctrl/Cmd "link modifier" tracker for Ctrl+click file/URL links.
// Both the terminal (renderer/terminal-links.js) and the file editor
// (viewer/file.js) light up links only while this modifier is held, so normal
// hover and drag-to-select stay untouched. One tracker keeps their notion of
// "is the modifier down" in sync and lets each subscribe to changes.

export const onMac = navigator.platform.toLowerCase().includes('mac');

let down = false;
const subscribers = new Set();

export function isLinkModDown() { return down; }

// Subscribe to modifier up/down transitions; returns an unsubscribe function.
export function subscribeLinkMod(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function set(next) {
  if (down === next) return;
  down = next;
  for (const cb of subscribers) cb(down);
}

// Capture phase so the modifier is tracked no matter which element has focus
// (a focused panel that stops propagation would otherwise hide the key from us).
window.addEventListener('keydown', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) set(true); }, true);
window.addEventListener('keyup', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) set(false); }, true);
window.addEventListener('blur', () => set(false));
