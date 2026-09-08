// --- console drawer for the inline browser ---
//
// A Chrome-DevTools-shaped console pinned to the bottom of the browser overlay:
// it streams the guest page's console output (and uncaught errors), collapses
// consecutive repeats into a count, filters by level and text, and its prompt
// evaluates an expression *in the page* via `executeJavaScript`.
//
// It starts collapsed and stays a head row until the user opens it, so the page
// keeps the full height by default. Capture runs whether or not the drawer is
// open — opening it shows what the page already logged, exactly like DevTools.
//
// The pure parts (level naming, repeat collapsing, the filter predicate, value
// formatting) live in shared/web-console-lib.js and are unit-tested.
import { t } from '../../i18n/index.js';
import { levelName, makeEntry, appendEntry, matchesFilter, countsByLevel, formatValue } from '../shared/web-console-lib.js';

const rootEl = document.getElementById('web-console');
const toggleEl = document.getElementById('web-console-toggle');
const resizeEl = document.getElementById('web-console-resize');
const logEl = document.getElementById('web-console-log');
const inputEl = document.getElementById('web-console-input');
const filterEl = document.getElementById('web-console-filter');
const levelEl = document.getElementById('web-console-level');
const clearBtn = document.getElementById('web-console-clear');
const errorsEl = document.getElementById('web-console-errors');
const warningsEl = document.getElementById('web-console-warnings');

let entries = [];
// The webview the prompt evaluates against — re-pointed by attachConsole() when
// terminateWeb() swaps in a fresh frame.
let frame = null;
// Command history for ↑/↓ at the prompt; `histIndex === history.length` is the
// live (not-yet-run) line.
const history = [];
let histIndex = 0;

const MIN_HEIGHT = 90;
const MAX_HEIGHT_RATIO = 0.8;

export const isConsoleOpen = () => !rootEl.classList.contains('collapsed');

export function setConsoleOpen(open) {
  rootEl.classList.toggle('collapsed', !open);
  if (open) { scrollToEnd(); inputEl.focus(); }
}

toggleEl.onclick = () => setConsoleOpen(!isConsoleOpen());

// --- capture ---

// `console-message` is the only capture hook that needs no guest preload, and it
// carries uncaught page errors too. Electron 31 passes (event, level, message,
// line, sourceId); newer builds pass a single event object — accept both.
function onConsoleMessage(e, level, message, line, sourceId) {
  const detail = typeof level === 'undefined' ? e : { level, message, lineNumber: line, sourceId };
  const src = detail.sourceId ? `${shortSource(detail.sourceId)}:${detail.lineNumber || 0}` : '';
  add(makeEntry('log', levelName(detail.level), detail.message, src));
}

const shortSource = (url) => String(url).split(/[\\/]/).pop() || String(url);

function add(entry) {
  const { added } = appendEntry(entries, entry);
  render();
  return added;
}

// Chrome clears the console on a top-level navigation (no "preserve log" here),
// but keeps it across same-document navigations.
export function clearConsole() {
  entries = [];
  render();
}

// Point the drawer at a webview and start capturing from it. Called for the
// initial frame and again for the replacement frame terminateWeb() builds.
export function attachConsole(webFrame) {
  frame = webFrame;
  webFrame.addEventListener('console-message', onConsoleMessage);
  webFrame.addEventListener('did-start-loading', clearConsole);
}

// --- rendering ---

function filterState() {
  return { level: levelEl.value, text: filterEl.value };
}

function render() {
  const state = filterState();
  const visible = entries.filter((e) => matchesFilter(e, state));
  const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.textContent = '';
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'wc-empty';
    empty.textContent = t(entries.length ? 'browser.consoleNoMatch' : 'browser.consoleEmpty');
    logEl.appendChild(empty);
  } else {
    for (const entry of visible) logEl.appendChild(rowFor(entry));
  }
  const counts = countsByLevel(entries);
  setBadge(errorsEl, counts.error, t('browser.levelError'));
  setBadge(warningsEl, counts.warning, t('browser.levelWarning'));
  if (atEnd) scrollToEnd();
}

const MARKS = { log: '', input: '›', result: '‹' };

function rowFor(entry) {
  const row = document.createElement('div');
  row.className = `wc-row wc-${entry.kind === 'log' ? entry.level : entry.kind}`;
  const mark = document.createElement('span');
  mark.className = 'wc-mark';
  mark.textContent = MARKS[entry.kind] || '';
  const text = document.createElement('span');
  text.className = 'wc-text';
  text.textContent = entry.text;
  row.append(mark, text);
  if (entry.count > 1) {
    const count = document.createElement('span');
    count.className = 'wc-count';
    count.textContent = String(entry.count);
    row.appendChild(count);
  }
  if (entry.source) {
    const src = document.createElement('span');
    src.className = 'wc-source';
    src.textContent = entry.source;
    row.appendChild(src);
  }
  return row;
}

// Just the count plus a tooltip naming the level — a translated "3 errors"
// would need plural rules for one badge.
function setBadge(el, n, label) {
  el.hidden = !n;
  el.textContent = String(n);
  el.title = label;
}

const scrollToEnd = () => { logEl.scrollTop = logEl.scrollHeight; };

filterEl.addEventListener('input', render);
levelEl.addEventListener('change', render);
clearBtn.onclick = clearConsole;

// --- prompt ---

async function evaluate(expr) {
  add(makeEntry('input', 'info', expr));
  history.push(expr);
  histIndex = history.length;
  if (!frame) return;
  try {
    // `userGesture: true` so the expression may do what a click could (open a
    // window, enter fullscreen) — DevTools evaluates the same way.
    const value = await frame.executeJavaScript(`(function(){ return (${expr}); })()`, true);
    add(makeEntry('result', 'info', formatValue(value)));
  } catch (err) {
    add(makeEntry('log', 'error', err && err.message ? err.message : String(err)));
  }
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const expr = inputEl.value.trim();
    if (!expr) return;
    inputEl.value = '';
    evaluate(expr);
  } else if (e.key === 'ArrowUp' && histIndex > 0) {
    e.preventDefault();
    inputEl.value = history[--histIndex];
  } else if (e.key === 'ArrowDown' && histIndex < history.length) {
    e.preventDefault();
    histIndex++;
    inputEl.value = histIndex === history.length ? '' : history[histIndex];
  }
});

// --- drag to resize ---
//
// The drawer's height is a CSS variable so the webview above just reflows; the
// pointer capture is on the handle, but a drag over the webview would otherwise
// have its events swallowed by the guest process, so the frame is made
// pointer-inert for the duration of the drag.
resizeEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizeEl.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startH = rootEl.getBoundingClientRect().height;
  if (frame) frame.style.pointerEvents = 'none';
  const onMove = (ev) => {
    const max = rootEl.parentElement.getBoundingClientRect().height * MAX_HEIGHT_RATIO;
    const h = Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
    rootEl.style.setProperty('--wc-height', `${Math.round(h)}px`);
  };
  const onUp = () => {
    resizeEl.removeEventListener('pointermove', onMove);
    resizeEl.removeEventListener('pointerup', onUp);
    if (frame) frame.style.pointerEvents = '';
  };
  resizeEl.addEventListener('pointermove', onMove);
  resizeEl.addEventListener('pointerup', onUp);
});

render();
