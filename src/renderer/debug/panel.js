// The debugger drawer: session picker + step controls, variables / watch / call
// stack / breakpoints, and the debug console (adapter output + a REPL). Driven
// by main's `debug-event` stream (main/debug.js); inspection goes back through
// window.api.debugRequest. Editor decorations (gutter dots, paused line) live in
// state.js and are drawn by viewer/file.js.
import {
  setExecLocation, setVerification, allBreakpoints, setBreakpointEnabled, removeBreakpoint,
  removeAllBreakpoints, onDebugDecorationsChanged,
} from './state.js';
import { openFromTree } from '../viewer/center.js';
import { promptText } from '../shared/prompt.js';

const $ = (id) => document.getElementById(id);
const panel = $('debug-panel');
const sessionSelect = $('debug-session');
const statusEl = $('debug-status');
const btn = {
  continue: $('debug-continue'), pause: $('debug-pause'), stepOver: $('debug-step-over'),
  stepIn: $('debug-step-in'), stepOut: $('debug-step-out'), restart: $('debug-restart'), stop: $('debug-stop'),
};
const variablesEl = $('debug-variables');
const watchEl = $('debug-watch');
const watchInput = $('debug-watch-input');
const stackEl = $('debug-stack');
const exceptionsEl = $('debug-exceptions');
const breakpointsEl = $('debug-breakpoints');
const logEl = $('debug-log');
const replInput = $('debug-input');

const MAX_LOG_NODES = 5000;

// id -> { id, name, state, request, exceptionFilters, enabledExceptionFilters,
//         threads, threadId, frames, frameId, stopReason }
const sessions = new Map();
let currentId = null;
const current = () => sessions.get(currentId) || null;

// ── Hooks for the toolbar ──────────────────────────────────────────────────
// The toolbar owns starting a config (it collects ${input:…} answers); we keep
// the last one so F5 / Restart can start it again.
let startHandler = null;
let lastStarted = null;
export function setDebugStartHandler(fn) { startHandler = fn; }
export function noteDebugStarted(name) {
  if (name) lastStarted = name; // an ad-hoc "Debug this file" run has no config to restart by name
  showPanel();
}

const sessionListeners = new Set();
export function onDebugSessionsChanged(cb) { sessionListeners.add(cb); }
export function debuggingNames() { return new Set([...sessions.values()].map((s) => s.name)); }
function notifySessions() { for (const cb of sessionListeners) cb(); }

export function showPanel() { panel.hidden = false; }
$('debug-close').onclick = () => { panel.hidden = true; };

// ── Events from main ───────────────────────────────────────────────────────
window.api.onDebugEvent((ev) => { handleEvent(ev); });

async function handleEvent(ev) {
  let s = sessions.get(ev.sessionId);
  if (!s) {
    if (ev.kind === 'ended') return;
    s = { id: ev.sessionId, name: ev.name, state: 'starting', request: 'launch', exceptionFilters: [], enabledExceptionFilters: [], threads: [], frames: [] };
    sessions.set(s.id, s);
    if (currentId == null) currentId = s.id;
    showPanel();
    notifySessions();
  }
  switch (ev.kind) {
    case 'state':
      s.state = ev.state;
      s.request = ev.request;
      s.exceptionFilters = ev.exceptionFilters || [];
      s.enabledExceptionFilters = ev.enabledExceptionFilters || [];
      break;
    case 'output':
      appendLog(ev.text, ev.category);
      return;
    case 'error':
      showPanel();
      return;
    case 'stopped':
      s.state = 'paused';
      s.stopReason = ev.description || ev.reason;
      if (ev.threadId) s.threadId = ev.threadId;
      currentId = s.id;
      await loadStack(s);
      window.focus();
      break;
    case 'continued':
      s.state = 'running';
      s.frames = [];
      s.frameId = null;
      if (s.id === currentId) setExecLocation(null);
      break;
    case 'breakpoints':
      setVerification(ev.file, ev.breakpoints);
      return;
    case 'ended':
      sessions.delete(s.id);
      appendLog(`Debug session "${s.name}" ended.\n`, 'console');
      if (currentId === s.id) {
        currentId = sessions.size ? sessions.keys().next().value : null;
        setExecLocation(null);
      }
      notifySessions();
      break;
  }
  render();
}

// ── Call stack ─────────────────────────────────────────────────────────────
async function request(s, command, args) {
  const r = await window.api.debugRequest(s.id, command, args);
  if (!r.ok) throw new Error(r.error);
  return r.body;
}

async function loadStack(s) {
  try {
    s.threads = (await request(s, 'threads')).threads || [];
    if (!s.threadId && s.threads.length) s.threadId = s.threads[0].id;
    s.frames = (await request(s, 'stackTrace', { threadId: s.threadId, startFrame: 0, levels: 100 })).stackFrames || [];
  } catch (e) {
    appendLog(`Couldn't read the call stack: ${e.message}\n`, 'stderr');
    s.frames = [];
  }
  if (s.frames.length) await selectFrame(s, s.frames[0]);
}

async function selectFrame(s, frame) {
  s.frameId = frame.id;
  const rel = frame.source && frame.source.rel;
  if (rel) {
    await openFromTree(rel, { line: frame.line });
    setExecLocation({ file: rel, line: frame.line });
  } else {
    setExecLocation(null);
  }
  render();
}

function renderStack() {
  stackEl.innerHTML = '';
  const s = current();
  if (!s || s.state !== 'paused') { stackEl.append(emptyNote(s ? 'Running' : 'Not debugging')); return; }
  for (const thread of s.threads.length ? s.threads : [{ id: s.threadId, name: 'Thread' }]) {
    const head = document.createElement('div');
    head.className = 'dbg-thread';
    const isStopped = thread.id === s.threadId;
    head.textContent = `${thread.name}${isStopped ? ` — paused${s.stopReason ? ` on ${s.stopReason}` : ''}` : ''}`;
    if (!isStopped) {
      head.style.cursor = 'pointer';
      head.title = 'Show this thread\'s call stack';
      head.onclick = async () => { s.threadId = thread.id; await loadStack(s); };
    }
    stackEl.append(head);
    if (!isStopped) continue;
    for (const frame of s.frames) {
      const row = document.createElement('div');
      row.className = 'dbg-frame' + (frame.id === s.frameId ? ' selected' : '') + (frame.source && frame.source.rel ? '' : ' external');
      const name = document.createElement('span');
      name.className = 'dbg-frame-name';
      name.textContent = frame.name;
      const loc = document.createElement('span');
      loc.className = 'dbg-frame-loc';
      const src = frame.source || {};
      loc.textContent = `${src.rel || src.name || src.path || '?'}:${frame.line}`;
      loc.title = src.path || '';
      row.append(name, loc);
      row.onclick = () => selectFrame(s, frame);
      stackEl.append(row);
    }
  }
}

// ── Variables & watch ──────────────────────────────────────────────────────
// Expansion is remembered by path (scope › var › child) so stepping keeps the
// tree open the way the user left it. Scopes open by default unless expensive.
const expanded = new Set();
const collapsed = new Set();
const isOpen = (key, byDefault) => expanded.has(key) || (byDefault && !collapsed.has(key));

let variablesRender = 0;
async function renderVariables() {
  const render = ++variablesRender;
  const s = current();
  if (!s || s.state !== 'paused' || s.frameId == null) {
    variablesEl.innerHTML = '';
    variablesEl.append(emptyNote(s ? 'Available while paused' : 'Not debugging'));
    return;
  }
  let scopes = [];
  try { scopes = (await request(s, 'scopes', { frameId: s.frameId })).scopes || []; }
  catch (e) { scopes = []; appendLog(`Couldn't read variables: ${e.message}\n`, 'stderr'); }
  if (render !== variablesRender) return;
  const fragment = document.createDocumentFragment();
  scopes.forEach((scope, i) => {
    variableRow(s, fragment, { name: scope.name, value: '', ref: scope.variablesReference, isScope: true }, 0, scope.name, i === 0 && !scope.expensive);
  });
  variablesEl.innerHTML = '';
  variablesEl.append(fragment);
}

function variableRow(s, container, item, depth, key, openByDefault, parentRef) {
  const row = document.createElement('div');
  row.className = 'dbg-row';
  row.style.paddingLeft = `${depth * 12 + 4}px`;
  const twisty = document.createElement('span');
  twisty.className = 'dbg-twisty';
  const name = document.createElement('span');
  name.className = item.isScope ? '' : 'dbg-name';
  name.textContent = item.name;
  row.append(twisty, name);
  if (!item.isScope) {
    const value = document.createElement('span');
    value.className = 'dbg-value' + (item.error ? ' error' : '');
    value.textContent = item.value;
    value.title = item.type ? `${item.type}: ${item.value}` : item.value;
    row.append(value);
    if (parentRef) {
      value.ondblclick = () => editVariable(s, parentRef, item);
    }
  }
  if (item.remove) {
    const remove = document.createElement('button');
    remove.className = 'dbg-remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.onclick = item.remove;
    row.append(remove);
  }
  container.append(row);
  if (!(item.ref > 0)) return;
  const children = document.createElement('div');
  container.append(children);
  let open = false;
  const show = async () => {
    open = true;
    twisty.textContent = '▾';
    let vars = [];
    try { vars = (await request(s, 'variables', { variablesReference: item.ref })).variables || []; }
    catch (e) { vars = [{ name: '', value: e.message, error: true }]; }
    children.innerHTML = '';
    for (const v of vars) {
      variableRow(s, children, { name: v.name, value: v.value, type: v.type, ref: v.variablesReference }, depth + 1, `${key}›${v.name}`, false, item.ref);
    }
  };
  const hide = () => { open = false; twisty.textContent = '▸'; children.innerHTML = ''; };
  twisty.textContent = '▸';
  row.onclick = (e) => {
    if (e.target.closest('.dbg-remove')) return;
    if (open) { hide(); expanded.delete(key); collapsed.add(key); }
    else { show(); expanded.add(key); collapsed.delete(key); }
  };
  if (isOpen(key, openByDefault)) show();
}

async function editVariable(s, parentRef, item) {
  const value = await promptText({ title: `Set ${item.name}`, label: 'New value (an expression)', value: item.value, ok: 'Set' });
  if (value == null) return;
  try { await request(s, 'setVariable', { variablesReference: parentRef, name: item.name, value }); }
  catch (e) { appendLog(`Couldn't set ${item.name}: ${e.message}\n`, 'stderr'); }
  renderVariables();
  renderWatch();
}

const WATCH_KEY = 'debug.watch';
let watches = [];
try { watches = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch { watches = []; }
const saveWatches = () => { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watches)); } catch { /* not persisted */ } };

watchInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !watchInput.value.trim()) return;
  watches.push(watchInput.value.trim());
  watchInput.value = '';
  saveWatches();
  renderWatch();
});

let watchRender = 0;
async function renderWatch() {
  const render = ++watchRender;
  const s = current();
  const paused = s && s.state === 'paused' && s.frameId != null;
  const results = await Promise.all(watches.map(async (expression) => {
    if (!paused) return { name: expression, value: 'not available', ref: 0 };
    try {
      const body = await request(s, 'evaluate', { expression, frameId: s.frameId, context: 'watch' });
      return { name: expression, value: body.result, type: body.type, ref: body.variablesReference };
    } catch (e) {
      return { name: expression, value: e.message, ref: 0, error: true };
    }
  }));
  if (render !== watchRender) return;
  watchEl.innerHTML = '';
  results.forEach((item, i) => {
    item.remove = () => { watches.splice(i, 1); saveWatches(); renderWatch(); };
    variableRow(s, watchEl, item, 0, `watch:${item.name}`, false);
  });
}

// ── Breakpoints & exception filters ────────────────────────────────────────
function renderBreakpoints() {
  exceptionsEl.innerHTML = '';
  const s = current();
  for (const filter of (s && s.exceptionFilters) || []) {
    const label = document.createElement('label');
    label.className = 'dbg-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = s.enabledExceptionFilters.includes(filter.filter);
    box.onchange = async () => {
      s.enabledExceptionFilters = box.checked
        ? [...s.enabledExceptionFilters, filter.filter]
        : s.enabledExceptionFilters.filter((f) => f !== filter.filter);
      await window.api.debugSetExceptionFilters(s.id, s.enabledExceptionFilters);
    };
    const text = document.createElement('span');
    text.textContent = filter.label;
    label.title = filter.description || filter.label;
    label.append(box, text);
    exceptionsEl.append(label);
  }

  breakpointsEl.innerHTML = '';
  const all = allBreakpoints();
  if (!all.length) { breakpointsEl.append(emptyNote('Click left of a line number (or press F9) to add one')); return; }
  const removeAll = document.createElement('div');
  removeAll.className = 'dbg-check';
  removeAll.textContent = 'Remove all breakpoints';
  removeAll.style.color = 'var(--fg-dim)';
  removeAll.onclick = removeAllBreakpoints;
  breakpointsEl.append(removeAll);
  for (const bp of all) {
    const row = document.createElement('div');
    row.className = 'dbg-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = bp.enabled !== false;
    box.onclick = (e) => e.stopPropagation();
    box.onchange = () => setBreakpointEnabled(bp.file, bp.line, box.checked);
    const name = document.createElement('span');
    name.textContent = bp.file.split('/').pop();
    const detail = document.createElement('span');
    detail.className = 'dbg-detail';
    detail.textContent = bp.logMessage ? `log: ${bp.logMessage}` : bp.hitCondition ? `hits: ${bp.hitCondition}` : bp.condition || '';
    const loc = document.createElement('span');
    loc.className = 'dbg-loc';
    loc.textContent = `${bp.file}:${bp.line}`;
    const remove = document.createElement('button');
    remove.className = 'dbg-remove';
    remove.textContent = '×';
    remove.title = 'Remove breakpoint';
    remove.onclick = (e) => { e.stopPropagation(); removeBreakpoint(bp.file, bp.line); };
    row.append(box, name, detail, loc, remove);
    row.onclick = () => openFromTree(bp.file, { line: bp.line });
    breakpointsEl.append(row);
  }
}
onDebugDecorationsChanged(renderBreakpoints);

// ── Debug console ──────────────────────────────────────────────────────────
function appendLog(text, category = 'console') {
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
  const span = document.createElement('span');
  span.className = `dbg-out-${category}`;
  span.textContent = text;
  logEl.append(span);
  while (logEl.childNodes.length > MAX_LOG_NODES) logEl.firstChild.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}
$('debug-console-clear').onclick = () => { logEl.innerHTML = ''; };

const replHistory = [];
let historyIndex = 0;
replInput.addEventListener('keydown', async (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!replHistory.length) return;
    historyIndex = Math.max(0, Math.min(replHistory.length, historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
    replInput.value = replHistory[historyIndex] || '';
    e.preventDefault();
    return;
  }
  if (e.key !== 'Enter') return;
  const expression = replInput.value.trim();
  if (!expression) return;
  replInput.value = '';
  replHistory.push(expression);
  historyIndex = replHistory.length;
  appendLog(`› ${expression}\n`, 'input');
  const s = current();
  if (!s) { appendLog('No active debug session.\n', 'stderr'); return; }
  try {
    const body = await request(s, 'evaluate', { expression, frameId: s.frameId == null ? undefined : s.frameId, context: 'repl' });
    if (body.result) appendLog(`${body.result}\n`, 'result');
  } catch (e2) {
    appendLog(`${e2.message}\n`, 'stderr');
  }
  // The expression may have changed state (assignments), so refresh the views.
  if (s.state === 'paused') { renderVariables(); renderWatch(); }
});

// ── Controls & keyboard ────────────────────────────────────────────────────
async function step(command) {
  const s = current();
  if (!s || s.state !== 'paused') return;
  try { await request(s, command, { threadId: s.threadId }); }
  catch (e) { appendLog(`${command} failed: ${e.message}\n`, 'stderr'); }
}

async function pause() {
  const s = current();
  if (!s || s.state !== 'running') return;
  try {
    const threads = (await request(s, 'threads')).threads || [];
    if (threads.length) await request(s, 'pause', { threadId: s.threadId || threads[0].id });
  } catch (e) { appendLog(`Pause failed: ${e.message}\n`, 'stderr'); }
}

async function stop() {
  const s = current();
  if (s) await window.api.debugStop(s.id);
}

async function restart() {
  const s = current();
  const name = s ? s.name : lastStarted;
  if (s) await window.api.debugStop(s.id);
  if (name && startHandler) startHandler(name);
}

// F5: continue when paused, else (re)start the last-debugged config.
function continueOrStart() {
  const s = current();
  if (s && s.state === 'paused') step('continue');
  else if (!s && startHandler) startHandler(lastStarted);
}

btn.continue.onclick = continueOrStart;
btn.pause.onclick = pause;
btn.stepOver.onclick = () => step('next');
btn.stepIn.onclick = () => step('stepIn');
btn.stepOut.onclick = () => step('stepOut');
btn.restart.onclick = restart;
btn.stop.onclick = stop;

// VS Code's debug keys, captured window-wide (they'd otherwise reach a
// focused terminal as escape sequences).
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  let action = null;
  if (e.key === 'F5' && mod && e.shiftKey) action = restart;
  else if (e.key === 'F5' && e.shiftKey) action = stop;
  else if (e.key === 'F5' && !mod) action = continueOrStart;
  else if (e.key === 'F6') action = pause;
  else if (e.key === 'F10') action = () => step('next');
  else if (e.key === 'F11' && e.shiftKey) action = () => step('stepOut');
  else if (e.key === 'F11') action = () => step('stepIn');
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action();
}, true);

sessionSelect.onchange = () => {
  currentId = Number(sessionSelect.value);
  const s = current();
  if (s && s.state === 'paused' && s.frames.length) selectFrame(s, s.frames.find((f) => f.id === s.frameId) || s.frames[0]);
  else { setExecLocation(null); render(); }
};

// ── Rendering ──────────────────────────────────────────────────────────────
function emptyNote(text) {
  const el = document.createElement('div');
  el.className = 'debug-empty';
  el.textContent = text;
  return el;
}

function renderHead() {
  sessionSelect.innerHTML = '';
  for (const s of sessions.values()) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.name;
    opt.selected = s.id === currentId;
    sessionSelect.append(opt);
  }
  sessionSelect.hidden = sessions.size < 2;
  const s = current();
  const paused = !!s && s.state === 'paused';
  statusEl.className = paused ? 'paused' : '';
  statusEl.textContent = !s ? 'Not debugging'
    : s.state === 'starting' ? `${s.name} — starting…`
      : paused ? `${s.name} — paused${s.stopReason ? ` on ${s.stopReason}` : ''}`
        : `${s.name} — running`;
  btn.continue.disabled = !(paused || (!s && lastStarted));
  btn.continue.title = s ? 'Continue (F5)' : `Start debugging ${lastStarted || ''} (F5)`;
  btn.pause.disabled = !s || s.state !== 'running';
  btn.stepOver.disabled = btn.stepIn.disabled = btn.stepOut.disabled = !paused;
  btn.stop.disabled = !s;
  btn.restart.disabled = !s && !lastStarted;
}

function render() {
  renderHead();
  renderStack();
  renderVariables();
  renderWatch();
  renderBreakpoints();
}

// Drag the top edge to resize; the height is remembered per machine.
const HEIGHT_KEY = 'debug.panelHeight';
try { const h = localStorage.getItem(HEIGHT_KEY); if (h) panel.style.setProperty('--debug-height', h); } catch { /* default height */ }
$('debug-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = panel.getBoundingClientRect().height;
  const onMove = (ev) => panel.style.setProperty('--debug-height', `${Math.max(120, startHeight + startY - ev.clientY)}px`);
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    try { localStorage.setItem(HEIGHT_KEY, panel.style.getPropertyValue('--debug-height')); } catch { /* not persisted */ }
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

render();
