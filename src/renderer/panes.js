import { fitActive } from './sessions.js';
import { fitConsole } from './consoles.js';

// --- resizable panes ---
// Drag a gutter to resize the pane on its near side; clamp to [min, max()].
// read() = current size px, write(px) sets a CSS var; sign flips for gutters
// whose pane is on the far side (the right column shrinks as you drag right).
const appEl = document.getElementById('app');
const sidebarEl = document.getElementById('sidebar');
const gitEl = document.getElementById('git');
const CENTER_MIN = 200;

function resizer(gutter, axis, sign, read, write, min, max) {
  gutter.onpointerdown = (e) => {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const base = read();
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      write(Math.max(min, Math.min(max(), base + sign * d)) + 'px');
      fitActive(); // ponytail: reflow live; throttle if janky
      fitConsole();
    };
    const up = (ev) => {
      gutter.classList.remove('dragging');
      gutter.releasePointerCapture(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  };
}

resizer(document.getElementById('gutter-left'), 'x', +1,
  () => sidebarEl.getBoundingClientRect().width,
  (v) => appEl.style.setProperty('--left', v),
  150, () => window.innerWidth - gitEl.getBoundingClientRect().width - CENTER_MIN);

resizer(document.getElementById('gutter-right'), 'x', -1,
  () => gitEl.getBoundingClientRect().width,
  (v) => appEl.style.setProperty('--right', v),
  180, () => window.innerWidth - sidebarEl.getBoundingClientRect().width - CENTER_MIN);

resizer(document.getElementById('gutter-sess'), 'y', +1,
  () => document.getElementById('sessions-pane').getBoundingClientRect().height,
  (v) => sidebarEl.style.setProperty('--sess-h', v),
  80, () => sidebarEl.getBoundingClientRect().height - 140);

// Console sits on the far (bottom) side of its gutter, so dragging down shrinks it.
resizer(document.getElementById('gutter-console'), 'y', -1,
  () => document.getElementById('git-console').getBoundingClientRect().height,
  (v) => gitEl.style.setProperty('--console-h', v),
  80, () => gitEl.getBoundingClientRect().height - 160);

// Commit box: grows to fit its content as you type (capped at 400px, then
// scrolls), so the height always matches the message without manual resizing.
const commitMsg = document.getElementById('commit-msg');
const fitCommitMsg = () => {
  commitMsg.style.height = 'auto';
  const cs = getComputedStyle(commitMsg);
  // scrollHeight omits the border, but border-box height includes it — add the
  // border back (offsetHeight - clientHeight) so the box isn't a few px short and
  // doesn't spawn a scrollbar before reaching the cap. Cap at 4 rows, then scroll.
  const border = commitMsg.offsetHeight - commitMsg.clientHeight;
  const max = parseFloat(cs.lineHeight) * 4
    + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
  commitMsg.style.height = Math.min(max, commitMsg.scrollHeight + border) + 'px';
};
commitMsg.addEventListener('input', fitCommitMsg);

window.addEventListener('resize', () => { fitActive(); fitConsole(); });
