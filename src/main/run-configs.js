const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getRepoPath, onRepoChange } = require('./repo');
const { getWin } = require('./window');

// --- VS Code run configs (.vscode/launch.json + tasks.json) ---
// We don't run a real debugger; each launch config / task is translated into a
// shell command and opened in an in-app terminal tab (see the renderer).

// Parse JSONC (VS Code config files allow // and /* */ comments and trailing
// commas). Strip comments outside of strings, drop trailing commas, JSON.parse.
function parseJsonc(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readVscodeJson(name) {
  try { return parseJsonc(fs.readFileSync(path.join(getRepoPath(), '.vscode', name), 'utf8')); }
  catch { return null; }
}

// Resolve the VS Code variables we can without a live editor context. Unknown
// ${...} placeholders (e.g. ${file}) are left untouched — best effort.
function substVars(str) {
  if (typeof str !== 'string') return str;
  const repoPath = getRepoPath();
  return str
    .replace(/\$\{workspaceFolder(?:Basename)?\}/g, (m) => m.includes('Basename') ? path.basename(repoPath) : repoPath)
    .replace(/\$\{workspaceRoot\}/g, repoPath)
    .replace(/\$\{cwd\}/g, repoPath)
    .replace(/\$\{pathSeparator\}/g, path.sep)
    .replace(/\$\{env:([^}]+)\}/g, (_, n) => process.env[n] || '');
}

const quoteArg = (a) => { a = String(a); return /\s/.test(a) ? `"${a}"` : a; };
function envMap(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = substVars(String(v));
  return out;
}

// Turn a launch config into a runnable command line. Covers the common node /
// python cases plus a generic runtimeExecutable/program fallback; returns null
// when there's nothing executable to derive.
function buildLaunchCommand(cfg) {
  const program = cfg.program ? substVars(cfg.program) : '';
  const args = (cfg.args || []).map(substVars);
  const runExe = cfg.runtimeExecutable ? substVars(cfg.runtimeExecutable) : '';
  const runArgs = (cfg.runtimeArgs || []).map(substVars);
  const type = (cfg.type || '').toLowerCase();
  let parts;
  if (type.includes('node')) parts = [runExe || 'node', ...runArgs, program, ...args];
  else if (type.includes('python') || type === 'debugpy') parts = [runExe || 'python', ...runArgs, program, ...args];
  else if (runExe) parts = [runExe, ...runArgs, program, ...args];
  else if (program) parts = [program, ...args];
  else return null;
  return parts.filter((p) => p !== '' && p != null).map(quoteArg).join(' ');
}

// Turn a task into a command line: `command` (verbatim for shell tasks, which may
// be a full line) followed by its quoted args. Returns null with no command.
function buildTaskCommand(task) {
  let command = task.command;
  if (command && typeof command === 'object') command = command.value;
  command = substVars(command || '');
  if (!command) return null;
  const args = (task.args || []).map((a) => substVars(typeof a === 'object' ? (a.value ?? '') : a));
  if (task.type === 'process') return [command, ...args].map(quoteArg).join(' ');
  return [command, ...args.map(quoteArg)].join(' '); // shell task: command stays verbatim
}

// A run spec the renderer turns into an in-app terminal tab: the command line plus
// the cwd/env to spawn its shell in, and the name used as the tab label.
function launchSpec(cfg) {
  const cmd = buildLaunchCommand(cfg);
  if (!cmd) return null;
  return { command: cmd, cwd: cfg.cwd ? substVars(cfg.cwd) : getRepoPath(), env: envMap(cfg.env), name: cfg.name };
}

// Names for the toolbar: launch configs + compounds, then task labels.
ipcMain.handle('get-run-configs', () => {
  const launch = readVscodeJson('launch.json');
  const tasks = readVscodeJson('tasks.json');
  const launchList = [];
  if (launch) {
    for (const c of (launch.configurations || [])) if (c && c.name) launchList.push({ name: c.name });
    for (const c of (launch.compounds || [])) if (c && c.name) launchList.push({ name: c.name, compound: true });
  }
  const taskList = [];
  if (tasks) for (const t of (tasks.tasks || [])) { const n = t && (t.label || t.taskName); if (n) taskList.push({ name: n }); }
  return { launch: launchList, tasks: taskList };
});

// Resolve one config/task by name into run specs (re-reads the files so edits are
// always picked up). The renderer opens an in-app terminal per spec; a compound
// yields one spec per referenced configuration.
ipcMain.handle('run-config', (_e, { kind, name }) => {
  if (kind === 'task') {
    const tasks = readVscodeJson('tasks.json');
    const t = (tasks && tasks.tasks || []).find((x) => (x.label || x.taskName) === name);
    if (!t) return { ok: false, error: 'Task not found' };
    const cmd = buildTaskCommand(t);
    if (!cmd) return { ok: false, error: 'Task has no command' };
    const opt = t.options || {};
    return { ok: true, runs: [{ command: cmd, cwd: opt.cwd ? substVars(opt.cwd) : getRepoPath(), env: envMap(opt.env), name }] };
  }
  const launch = readVscodeJson('launch.json');
  if (!launch) return { ok: false, error: 'No launch.json' };
  const compound = (launch.compounds || []).find((c) => c.name === name);
  if (compound) {
    const runs = [];
    for (const ref of (compound.configurations || [])) {
      const refName = typeof ref === 'object' ? ref.name : ref;
      const cfg = (launch.configurations || []).find((c) => c.name === refName);
      if (cfg) { const s = launchSpec(cfg); if (s) runs.push(s); }
    }
    return runs.length ? { ok: true, runs } : { ok: false, error: 'Compound references no runnable configs' };
  }
  const cfg = (launch.configurations || []).find((c) => c.name === name);
  if (!cfg) return { ok: false, error: 'Config not found' };
  const s = launchSpec(cfg);
  return s ? { ok: true, runs: [s] } : { ok: false, error: 'Could not derive a run command for this config' };
});

// Keep the toolbar in sync with the .vscode files without the user reopening the
// folder. fs.watchFile polls the two paths (works even before they exist, and
// fires on create/edit/delete), so a `tasks.json`/`launch.json` change pushes a
// `run-configs-changed` event and the renderer rebuilds the toolbar.
let watched = [];
function unwatchVscode() {
  for (const p of watched) fs.unwatchFile(p);
  watched = [];
}
function watchVscode() {
  unwatchVscode();
  const onChange = () => { const win = getWin(); if (win) win.webContents.send('run-configs-changed'); };
  for (const name of ['launch.json', 'tasks.json']) {
    const p = path.join(getRepoPath(), '.vscode', name);
    fs.watchFile(p, { interval: 2000 }, (cur, prev) => {
      // mtimeMs is 0 when the file is absent; only react when presence/content changed.
      if (cur.mtimeMs !== prev.mtimeMs) onChange();
    });
    watched.push(p);
  }
}

watchVscode();
onRepoChange(watchVscode);

module.exports = {};
