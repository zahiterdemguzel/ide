const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getRepoPath, onRepoChange } = require('./repo');
const { getWin } = require('./window');
const { parseJsonc, makeRunConfigLib } = require('./run-configs-lib');

// --- VS Code run configs (.vscode/launch.json + tasks.json) ---
// We don't run a real debugger; each launch config / task is translated into a
// shell command and opened in an in-app terminal tab (see the renderer). The
// pure translation lives in run-configs-lib.js (Electron-free, unit-tested);
// this module owns the file IO, IPC, and the .vscode watcher.

function readVscodeJson(name) {
  try { return parseJsonc(fs.readFileSync(path.join(getRepoPath(), '.vscode', name), 'utf8')); }
  catch { return null; }
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
  const { resolveTask, launchSpec } = makeRunConfigLib(getRepoPath());
  if (kind === 'task') {
    const tasks = readVscodeJson('tasks.json');
    const all = (tasks && tasks.tasks) || [];
    const t = all.find((x) => (x.label || x.taskName) === name);
    if (!t) return { ok: false, error: 'Task not found' };
    const runs = resolveTask(all, t);
    if (!runs.length) return { ok: false, error: 'Task has no runnable command (a compound must reference tasks that do)' };
    return { ok: true, runs };
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
  if (s) return { ok: true, runs: [s] };
  const ofType = cfg.type ? ` of type "${cfg.type}"` : '';
  return { ok: false, error: `Couldn't derive a run command for "${name}"${ofType}. This config has no runnable "program" or "runtimeExecutable" — it's likely a browser or attach config, which this app can't launch as a terminal command.` };
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
