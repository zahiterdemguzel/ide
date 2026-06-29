import { Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme, attachRenderer } from './shared/terminal.js';
import { registerTerminalLinks } from './terminal-links.js';

// --- git-pane consoles: multiple interactive shell terminals as tabs ---
// Each tab owns one xterm + PTY. Manual tabs are named after their shell (cmd/ps);
// tabs opened by a launch config / task take the config name. Relaunching a config
// reuses its existing tab (matched by name) with a fresh shell.
const consoles = new Map(); // id -> { term, fit, host, tab, label, name, kind }
let activeConsole = null;
let shellList = [];

// Listeners notified whenever a console is opened or closed, so the run toolbar
// can flip a launch button between play (idle) and restart (its terminal alive).
const consolesChangedCbs = new Set();
export function onConsolesChanged(cb) { consolesChangedCbs.add(cb); return () => consolesChangedCbs.delete(cb); }
function notifyConsolesChanged() { for (const cb of consolesChangedCbs) cb(); }

// Names of the .vscode config terminals (kind 'config') still alive — a launch
// config "runs" exactly as long as the terminal it started is open (the user's
// definition). The toolbar reads this to decide play vs restart per button.
export function runningConfigNames() {
  const names = new Set();
  for (const c of consoles.values()) if (c.kind === 'config') names.add(c.name);
  return names;
}

// Stop the launch config's terminal(s): close every still-open config terminal
// named `name`. Killing the shell is what ends the "running" state the toolbar's
// Stop button reflects. (A compound stops each of its member config names.)
export function stopConfig(name) {
  for (const [id, c] of [...consoles]) {
    if (c.kind === 'config' && c.name === name) closeConsole(id);
  }
}

const consoleHosts = document.getElementById('console-hosts');
const termTabs = document.getElementById('term-tabs');

// The tab strip scrolls horizontally when there are more tabs than fit, but its
// scrollbar is hidden. Translate a plain vertical mouse wheel into horizontal
// scroll so the bar is navigable without a trackpad or Shift+wheel.
termTabs.addEventListener('wheel', (e) => {
  if (e.deltaX !== 0) return; // trackpad/horizontal intent already handled natively
  if (termTabs.scrollWidth <= termTabs.clientWidth) return; // nothing to scroll
  e.preventDefault();
  termTabs.scrollLeft += e.deltaY;
}, { passive: false });

function truncName(s, n = 16) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

export function fitConsole() {
  const c = activeConsole && consoles.get(activeConsole);
  if (!c) return;
  try {
    c.fit.fit();
    window.api.termResize(activeConsole, c.term.cols, c.term.rows);
  } catch { /* host hidden / zero-size */ }
}

function selectConsole(id) {
  if (!consoles.has(id)) return;
  activeConsole = id;
  // Only the visible console keeps a GPU renderer; release the others so live
  // WebGL contexts stay well under Chromium's cap (see attachRenderer).
  for (const [cid, cc] of consoles) {
    const on = cid === id;
    cc.host.style.display = on ? 'block' : 'none';
    cc.tab.classList.toggle('active', on);
    if (on) { if (!cc.renderer) cc.renderer = attachRenderer(cc.term); }
    else if (cc.renderer) { cc.renderer.dispose(); cc.renderer = null; }
  }
  fitConsole();
  // A hidden xterm keeps a stale scroll position until new output forces a
  // refresh; on reveal, snap to the bottom so the latest output is visible
  // immediately. The reveal + fit only take effect next frame, so snap there too.
  const { term } = consoles.get(id);
  term.scrollToBottom();
  requestAnimationFrame(() => { const c = consoles.get(id); if (c) c.term.scrollToBottom(); });
  term.focus();
}

function closeConsole(id) {
  const c = consoles.get(id);
  if (!c) return;
  window.api.termKill(id);
  if (c.renderer) c.renderer.dispose();
  untrackTermTheme(c.term);
  c.term.dispose();
  c.host.remove();
  c.tab.remove();
  consoles.delete(id);
  notifyConsolesChanged();
  if (activeConsole === id) {
    activeConsole = null;
    const next = [...consoles.keys()].pop();
    if (next) selectConsole(next);
    else createConsole({ shell: shellList[0] }); // always keep one terminal open
  }
}

// Build a tab + xterm + PTY. opts: { shell:{name,path}, command, cwd, env, name, kind }.
async function createConsole(opts = {}) {
  const term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'console-host';
  consoleHosts.appendChild(host);
  term.open(host);
  attachClipboard(term);
  registerTerminalLinks(term);
  try { fit.fit(); } catch { /* pane hidden */ }

  const { id } = await window.api.termCreate({
    cols: term.cols, rows: term.rows,
    shell: opts.shell && opts.shell.path,
    command: opts.command, cwd: opts.cwd, env: opts.env,
  });
  term.onData((d) => window.api.termInput(id, d));

  const name = opts.name || (opts.shell && opts.shell.name) || 'shell';
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.title = name;
  const label = document.createElement('span');
  label.className = 'term-tab-label';
  label.textContent = truncName(name);
  const close = document.createElement('button');
  close.className = 'term-tab-close';
  close.textContent = '×';
  close.title = 'Close terminal';
  close.onclick = (e) => { e.stopPropagation(); closeConsole(id); };
  tab.append(label, close);
  tab.onclick = () => selectConsole(id);
  tab.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); closeConsole(id); } };
  termTabs.appendChild(tab);

  consoles.set(id, { term, fit, host, tab, label, name, kind: opts.kind || 'shell', renderer: null });
  notifyConsolesChanged();
  selectConsole(id); // attaches the GPU renderer to this now-visible console
  return id;
}

// Run a launch/task/run-file spec: reuse a same-named tab of the same kind if one
// is still open (fresh shell, same tab), otherwise open a new one. Either way it
// gets focus. `spec.kind` distinguishes a .vscode config ('config', the default)
// from an editor "run this file" ('run'), so the two never collide on a tab.
export async function runSpecInConsole(spec) {
  const kind = spec.kind || 'config';
  for (const [id, c] of consoles) {
    if (c.kind === kind && c.name === spec.name) {
      c.term.reset();
      await window.api.termRestart({ id, cols: c.term.cols, rows: c.term.rows, command: spec.command, cwd: spec.cwd, env: spec.env });
      selectConsole(id);
      return id;
    }
  }
  return createConsole({ command: spec.command, cwd: spec.cwd, env: spec.env, name: spec.name, kind });
}

let shellMenuDismiss = null;
function closeShellMenu() {
  const m = document.getElementById('shell-menu');
  if (m) m.remove();
  if (shellMenuDismiss) { document.removeEventListener('pointerdown', shellMenuDismiss); shellMenuDismiss = null; }
}
function openShellMenu(anchor) {
  closeShellMenu();
  const menu = document.createElement('div');
  menu.id = 'shell-menu';
  for (const sh of shellList) {
    const item = document.createElement('button');
    item.className = 'shell-menu-item';
    item.textContent = sh.name;
    item.onclick = () => { closeShellMenu(); createConsole({ shell: sh }); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = (r.bottom + 2) + 'px';
  shellMenuDismiss = (e) => { if (!e.target.closest('#shell-menu') && e.target !== anchor) closeShellMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', shellMenuDismiss), 0);
}

window.api.onTermData(({ id, data }) => { const c = consoles.get(id); if (c) c.term.write(data); });
window.api.onTermExit(({ id }) => closeConsole(id)); // shell exited (e.g. user typed `exit`)

export async function initConsoles() {
  shellList = await window.api.termShells();
  const add = document.getElementById('term-add');
  add.onclick = () => {
    if (shellList.length <= 1) createConsole({ shell: shellList[0] });
    else openShellMenu(add);
  };
  document.getElementById('term-clear').onclick = () => {
    const c = activeConsole && consoles.get(activeConsole);
    if (c) { c.term.clear(); c.term.focus(); }
  };
  await createConsole({ shell: shellList[0] });
}
