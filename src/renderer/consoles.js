import { Terminal, FitAddon, termTheme, attachClipboard } from './shared/terminal.js';

// --- git-pane consoles: multiple interactive shell terminals as tabs ---
// Each tab owns one xterm + PTY. Manual tabs are named after their shell (cmd/ps);
// tabs opened by a launch config / task take the config name. Relaunching a config
// reuses its existing tab (matched by name) with a fresh shell.
const consoles = new Map(); // id -> { term, fit, host, tab, label, name, kind }
let activeConsole = null;
let shellList = [];

const consoleHosts = document.getElementById('console-hosts');
const termTabs = document.getElementById('term-tabs');

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
  for (const [cid, cc] of consoles) {
    const on = cid === id;
    cc.host.style.display = on ? 'block' : 'none';
    cc.tab.classList.toggle('active', on);
  }
  fitConsole();
  consoles.get(id).term.focus();
}

function closeConsole(id) {
  const c = consoles.get(id);
  if (!c) return;
  window.api.termKill(id);
  c.term.dispose();
  c.host.remove();
  c.tab.remove();
  consoles.delete(id);
  if (activeConsole === id) {
    activeConsole = null;
    const next = [...consoles.keys()].pop();
    if (next) selectConsole(next);
    else createConsole({ shell: shellList[0] }); // always keep one terminal open
  }
}

// Build a tab + xterm + PTY. opts: { shell:{name,path}, command, cwd, env, name, kind }.
async function createConsole(opts = {}) {
  const term = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement('div');
  host.className = 'console-host';
  consoleHosts.appendChild(host);
  term.open(host);
  attachClipboard(term);
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
  termTabs.appendChild(tab);

  consoles.set(id, { term, fit, host, tab, label, name, kind: opts.kind || 'shell' });
  selectConsole(id);
  return id;
}

// Run a launch/task spec: reuse a same-named config tab if one is still open
// (fresh shell, same tab), otherwise open a new one. Either way it gets focus.
export async function runSpecInConsole(spec) {
  for (const [id, c] of consoles) {
    if (c.kind === 'config' && c.name === spec.name) {
      c.term.reset();
      await window.api.termRestart({ id, cols: c.term.cols, rows: c.term.rows, command: spec.command, cwd: spec.cwd, env: spec.env });
      selectConsole(id);
      return id;
    }
  }
  return createConsole({ command: spec.command, cwd: spec.cwd, env: spec.env, name: spec.name, kind: 'config' });
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
