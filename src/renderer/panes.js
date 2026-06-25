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

// Commit box: custom top-right grip that grows the textarea upward (dragging up
// adds height), since a native resize handle can only sit at the bottom-end.
const commitMsg = document.getElementById('commit-msg');
const commitGrip = document.getElementById('commit-msg-grip');
commitGrip.onpointerdown = (e) => {
  e.preventDefault();
  commitGrip.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const base = commitMsg.getBoundingClientRect().height;
  const move = (ev) => {
    const h = Math.max(40, Math.min(400, base - (ev.clientY - startY)));
    commitMsg.style.height = h + 'px';
  };
  const up = (ev) => {
    commitGrip.releasePointerCapture(ev.pointerId);
    commitGrip.removeEventListener('pointermove', move);
    commitGrip.removeEventListener('pointerup', up);
  };
  commitGrip.addEventListener('pointermove', move);
  commitGrip.addEventListener('pointerup', up);
};

window.addEventListener('resize', () => { fitActive(); fitConsole(); });
