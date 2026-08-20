// --- inline browser: client-side console panel ---
// A DevTools-lite log pane docked to the bottom of the browser overlay. Every
// message the guest page logs (and every uncaught error, which Chromium reports
// as a console message) arrives on the <webview>'s `console-message` event; we
// keep them in a capped ring and render them as selectable rows so the user can
// highlight and copy a stack trace straight out of the panel.
//
// The panel is attached per <webview> element: web.js swaps the live webview on
// Terminate, so `attachConsole(frame)` is called for every frame it creates.

const panel = document.getElementById('web-console');
const bodyEl = document.getElementById('web-console-body');
const filterEl = document.getElementById('web-console-filter');
const toggleBtn = document.getElementById('web-console-btn');
const badgeEl = document.getElementById('web-console-badge');
const resizeEl = document.getElementById('web-console-resize');

const MAX_ENTRIES = 500;
let entries = [];
let errorCount = 0;

// Electron reports `level` as a number (0..3) on older versions and as a string
// on newer ones — normalise both to the class name we style with.
const LEVELS = ['log', 'log', 'warn', 'error'];
function levelName(level) {
  if (typeof level === 'number') return LEVELS[level] || 'log';
  const s = String(level || 'log').toLowerCase();
  if (s === 'warning' || s === 'warn') return 'warn';
  if (s === 'error') return 'error';
  if (s === 'debug' || s === 'verbose') return 'debug';
  return 'log';
}

// "main.js:42" — the short source suffix shown at the right of a row.
function sourceLabel(sourceId, line) {
  if (!sourceId) return '';
  const file = sourceId.split(/[\\/]/).pop() || sourceId;
  return line ? `${file}:${line}` : file;
}

const matchesFilter = (e) => {
  const q = filterEl.value.trim().toLowerCase();
  if (!q) return true;
  return e.text.toLowerCase().includes(q) || e.source.toLowerCase().includes(q);
};

function rowFor(entry) {
  const row = document.createElement('div');
  row.className = `wc-row wc-${entry.level}`;
  const msg = document.createElement('span');
  msg.className = 'wc-msg';
  msg.textContent = entry.text;
  row.appendChild(msg);
  if (entry.source) {
    const src = document.createElement('span');
    src.className = 'wc-src';
    src.textContent = entry.source;
    src.title = entry.sourceFull;
    row.appendChild(src);
  }
  return row;
}

function updateBadge() {
  badgeEl.textContent = errorCount > 99 ? '99+' : String(errorCount);
  badgeEl.hidden = errorCount === 0;
  toggleBtn.classList.toggle('has-errors', errorCount > 0);
}

function append(entry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
    render();
    return;
  }
  if (!matchesFilter(entry)) return;
  // Only follow the tail when the user hasn't scrolled up to read something.
  const atBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 24;
  bodyEl.appendChild(rowFor(entry));
  if (atBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function render() {
  bodyEl.innerHTML = '';
  for (const e of entries.filter(matchesFilter)) bodyEl.appendChild(rowFor(e));
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

// Wire a (possibly brand new) webview's console stream into the panel.
export function attachConsole(frame) {
  frame.addEventListener('console-message', (e) => {
    const level = levelName(e.level);
    if (level === 'error') { errorCount++; updateBadge(); }
    append({
      level,
      text: String(e.message == null ? '' : e.message),
      source: sourceLabel(e.sourceId, e.line),
      sourceFull: e.sourceId ? `${e.sourceId}:${e.line}` : '',
    });
  });
  // A fresh page's messages replace the previous page's, like a real console.
  frame.addEventListener('did-start-loading', clearConsole);
}

export function clearConsole() {
  entries = [];
  errorCount = 0;
  updateBadge();
  bodyEl.innerHTML = '';
}

export const isConsoleOpen = () => !panel.hidden;

export function toggleConsole(show) {
  const open = show === undefined ? panel.hidden : show;
  panel.hidden = !open;
  toggleBtn.classList.toggle('active', open);
  if (open) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function copyAll() {
  const text = entries.filter(matchesFilter)
    .map((e) => (e.source ? `${e.text}    (${e.sourceFull})` : e.text))
    .join('\n');
  if (!text) return;
  if (window.api && window.api.clipboardWrite) window.api.clipboardWrite(text);
  else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  const btn = document.getElementById('web-console-copy');
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 900);
}

toggleBtn.onclick = () => toggleConsole();
document.getElementById('web-console-close').onclick = () => toggleConsole(false);
document.getElementById('web-console-clear').onclick = clearConsole;
document.getElementById('web-console-copy').onclick = copyAll;
filterEl.addEventListener('input', render);

// Drag the top edge to resize. The panel is a flex item with an explicit height,
// so resizing is just clamping that height against the overlay's own box.
resizeEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = panel.getBoundingClientRect().height;
  const maxH = document.getElementById('web-view').clientHeight * 0.8;
  const onMove = (ev) => {
    panel.style.height = Math.max(80, Math.min(maxH, startH + (startY - ev.clientY))) + 'px';
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

updateBadge();
