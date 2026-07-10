console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/arm-hint.js'); // PERF-TEMP
import { t } from '../../i18n/index.js';

// The destructive buttons (discard, revert, terminate, delete) use a two-click
// "arm then confirm" pattern. The arming is easy to miss — the only cue was a
// tooltip you had to hover to see. This pops a small "Click again to approve"
// bubble next to the button on the first click so the second click is obvious.
//
// A single bubble is reused: arming a different button just moves and retargets
// it. It auto-fades as a safety net, and hideArmHint() clears it when the action
// fires or the button disarms.

let bubble = null;
let fadeTimer = null;
let onScroll = null;

function ensureBubble() {
  if (bubble) return bubble;
  bubble = document.createElement('div');
  bubble.className = 'arm-hint';
  bubble.setAttribute('role', 'status');
  bubble.hidden = true;
  document.body.appendChild(bubble);
  return bubble;
}

function place(anchor) {
  const r = anchor.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const margin = 10;
  // Prefer above the button (tail pointing down); flip below if there's no room.
  const below = r.top - b.height - margin < 0;
  bubble.classList.toggle('arm-hint-below', below);
  let left = r.left + r.width / 2 - b.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - b.width - margin));
  const top = below ? r.bottom + margin : r.top - b.height - margin;
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
  // The tail tracks the button even when the bubble is clamped to the viewport.
  const tail = r.left + r.width / 2 - left;
  bubble.style.setProperty('--arm-tail', `${Math.round(Math.max(14, Math.min(tail, b.width - 14)))}px`);
}

// Show the bubble pointing at `anchor`. Re-running the pop animation on each call
// makes a repeated arm feel responsive rather than static.
export function showArmHint(anchor, message) {
  if (!anchor) return;
  ensureBubble();
  bubble.textContent = message || t('armHint.clickAgain');
  bubble.hidden = false;
  bubble.classList.remove('arm-hint-pop');
  void bubble.offsetWidth; // restart the animation
  bubble.classList.add('arm-hint-pop');
  place(anchor);

  // Reposition if the panel behind the button scrolls; drop the bubble outright
  // once the button leaves view so it can't float over unrelated content.
  if (onScroll) window.removeEventListener('scroll', onScroll, true);
  onScroll = () => {
    if (bubble.hidden) return;
    const r = anchor.getBoundingClientRect();
    if (!anchor.isConnected || r.bottom < 0 || r.top > window.innerHeight) hideArmHint();
    else place(anchor);
  };
  window.addEventListener('scroll', onScroll, true);

  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(hideArmHint, 4000);
}

export function hideArmHint() {
  clearTimeout(fadeTimer);
  if (onScroll) { window.removeEventListener('scroll', onScroll, true); onScroll = null; }
  if (bubble) bubble.hidden = true;
}
