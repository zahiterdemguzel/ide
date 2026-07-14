const { ipcMain } = require('electron');
const bridge = require('./remote-bridge');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getRepoPath, onRepoChange } = require('./repo');
const { sendToRenderer } = require('./window');
const { stopConfigNamed } = require('./consoles');
const { parseJsonc, parseEnvFile, compoundMembers, findInputIds, defaultBuildTaskName, makeRunConfigLib } = require('./run-configs-lib');

// --- VS Code run configs (.vscode/launch.json + tasks.json) ---
// We don't run a real debugger; each launch config / task is translated into a
// shell command and opened in an in-app terminal tab (see the renderer). The
// pure translation lives in run-configs-lib.js (Electron-free, unit-tested);
// this module owns the file IO, IPC, and the .vscode watcher.

function readVscodeJson(name) {
  try { return parseJsonc(fs.readFileSync(path.join(getRepoPath(), '.vscode', name), 'utf8')); }
  catch { return null; }
}

const isHiddenLaunch = (c) => !!(c && c.presentation && c.presentation.hidden);
const orderOf = (c) => (c && c.presentation && typeof c.presentation.order === 'number') ? c.presentation.order : Infinity;
const byOrder = (a, b) => orderOf(a) - orderOf(b);

// Names for the toolbar: launch configs + compounds, then task labels. Entries a
// user hid in VS Code (task `hide`, launch/compound `presentation.hidden`) stay
// hidden here too, and `presentation.order` sorts the visible ones.
bridge.handle('get-run-configs', () => {
  const launch = readVscodeJson('launch.json');
  const tasks = readVscodeJson('tasks.json');
  const launchList = [];
  if (launch) {
    for (const c of [...(launch.configurations || [])].sort(byOrder)) {
      if (c && c.name && !isHiddenLaunch(c)) launchList.push({ name: c.name });
    }
    for (const c of [...(launch.compounds || [])].sort(byOrder)) {
      if (c && c.name && !isHiddenLaunch(c)) launchList.push({ name: c.name, compound: true, members: compoundMembers(c) });
    }
  }
  const taskList = [];
  if (tasks) {
    for (const t of (tasks.tasks || [])) {
      if (!t || t.hide) continue;
      const n = t.label || t.taskName;
      if (n) taskList.push({ name: n });
    }
  }
  return { launch: launchList, tasks: taskList };
});

// The pure lib bound to the open folder plus everything it can't know itself:
// ${userHome}, ${config:...} (settings.json), ${defaultBuildTask}, collected
// ${input:...} answers, and the renderer's active file for the ${file} family.
function makeLib(tasksJson, inputs, activeFile) {
  const repo = getRepoPath();
  const file = activeFile ? (path.isAbsolute(activeFile) ? activeFile : path.join(repo, activeFile)) : undefined;
  return makeRunConfigLib(repo, process.platform, {
    home: os.homedir(),
    settings: readVscodeJson('settings.json') || {},
    defaultBuildTask: defaultBuildTaskName((tasksJson && tasksJson.tasks) || []),
    inputs: inputs || {},
    activeFile: file,
  });
}

// If the resolved specs still reference ${input:id}s, describe what the renderer
// must ask the user (VS Code `inputs`: promptString / pickString — `command`
// inputs run an extension command, which we can't do). Returns null when the
// specs are ready to run.
function pendingInputs(runs, ...inputSources) {
  const ids = findInputIds(runs);
  if (!ids.length) return null;
  const defs = inputSources.flatMap((src) => (src && src.inputs) || []);
  const needs = [];
  for (const id of ids) {
    const d = defs.find((x) => x && x.id === id);
    if (!d || (d.type !== 'promptString' && d.type !== 'pickString')) {
      return { error: `This config uses \${input:${id}}, which ${d ? `is a "${d.type}" input this app can't run` : 'has no matching entry in "inputs"'}.` };
    }
    needs.push({
      id: d.id, type: d.type, description: d.description || d.id,
      default: d.default, options: d.options, password: !!d.password,
    });
  }
  return { needsInputs: needs };
}

// Resolve one config/task by name into run specs (re-reads the files so edits are
// always picked up). The renderer opens an in-app terminal per spec; a compound
// yields one spec per referenced configuration. When a spec needs ${input:...}
// answers, we instead return { needsInputs } and the renderer re-invokes with the
// collected values.
// Merge a launch config's `envFile` into the spec's env (file IO, so it lives here
// rather than the pure lib). envFile is the base; an explicit `env` key wins. A
// missing/unreadable file is ignored (VS Code warns but still launches).
function withEnvFile(spec, cfg, lib) {
  if (!spec || !cfg.envFile) return spec;
  try {
    const text = fs.readFileSync(lib.substVars(cfg.envFile), 'utf8');
    spec.env = { ...parseEnvFile(text), ...spec.env };
  } catch { /* envFile absent or unreadable: launch without it */ }
  return spec;
}

// Resolve a launch config's `preLaunchTask` (a task label, or
// "${defaultBuildTask}") into task specs to chain in front of the launch command.
function preLaunchSpecs(cfg, tasksJson, lib) {
  if (!cfg.preLaunchTask) return [];
  const all = lib.normalizeTasks(tasksJson);
  const name = lib.substVars(String(cfg.preLaunchTask));
  const t = all.find((x) => (x.label || x.taskName) === name);
  return t ? lib.resolveTask(all, t) : [];
}

function resolveLaunchConfig(cfg, tasksJson, lib) {
  const spec = withEnvFile(lib.launchSpec(cfg), cfg, lib);
  return spec ? lib.prependTasks(preLaunchSpecs(cfg, tasksJson, lib), spec) : null;
}

function resolveRunConfig({ kind, name, inputs, activeFile }) {
  const tasksJson = readVscodeJson('tasks.json');
  const lib = makeLib(tasksJson, inputs, activeFile);
  if (kind === 'task') {
    const all = lib.normalizeTasks(tasksJson);
    const t = all.find((x) => (x.label || x.taskName) === name);
    if (!t) return { ok: false, error: 'Task not found' };
    const runs = lib.resolveTask(all, t);
    if (!runs.length) return { ok: false, error: 'Task has no runnable command (a compound must reference tasks that do)' };
    const pending = pendingInputs(runs, tasksJson, readVscodeJson('launch.json'));
    if (pending) return { ok: false, ...pending };
    return { ok: true, runs };
  }
  const launch = readVscodeJson('launch.json');
  if (!launch) return { ok: false, error: 'No launch.json' };
  const done = (runs) => {
    const pending = pendingInputs(runs, launch, tasksJson);
    if (pending) return { ok: false, ...pending };
    return { ok: true, runs };
  };
  const compound = (launch.compounds || []).find((c) => c.name === name);
  if (compound) {
    // A compound-level preLaunchTask runs once, in its own terminal, before the
    // members (best effort: members start in parallel, as VS Code does).
    const runs = preLaunchSpecs(compound, tasksJson, lib);
    for (const ref of (compound.configurations || [])) {
      const refName = typeof ref === 'object' ? ref.name : ref;
      const cfg = (launch.configurations || []).find((c) => c.name === refName);
      if (cfg) { const s = resolveLaunchConfig(cfg, tasksJson, lib); if (s) runs.push(s); }
    }
    return runs.length ? done(runs) : { ok: false, error: 'Compound references no runnable configs' };
  }
  const cfg = (launch.configurations || []).find((c) => c.name === name);
  if (!cfg) return { ok: false, error: 'Config not found' };
  const s = resolveLaunchConfig(cfg, tasksJson, lib);
  if (s) return done([s]);
  const ofType = cfg.type ? ` of type "${cfg.type}"` : '';
  return { ok: false, error: `Couldn't derive a run command for "${name}"${ofType}. This config has no runnable "program" or "runtimeExecutable" (and no browser "url"/"file") — it's likely an attach config, which this app can't launch as a terminal command.` };
}

ipcMain.handle('run-config', (_e, args) => resolveRunConfig(args || {}));

// Start a config/task on behalf of a remote client. The phone can't open a
// terminal tab — the desktop renderer owns those — so main resolves the specs and
// pushes them to the renderer, which runs them through the very same path a
// toolbar click takes (reusing a same-named tab, so this is rerun as well as run).
// One code path means desktop and phone can't drift.
//
// ${input:...} configs are the one thing we can't do headlessly: the answers come
// from a modal the desktop renderer owns. Say so rather than silently running a
// config with unresolved placeholders.
bridge.handle('run-config-start', (_e, { kind, name } = {}) => {
  const r = resolveRunConfig({ kind, name });
  if (r.needsInputs) {
    const ids = r.needsInputs.map((i) => i.id).join(', ');
    return { ok: false, error: `"${name}" asks for input (${ids}). Start it from the desktop toolbar — the prompt opens there.` };
  }
  if (!r.ok) return r;
  sendToRenderer('run-specs', { runs: r.runs });
  return { ok: true };
});

// Stop a launch config: close the terminal(s) it started. A compound stops each of
// its member configs, exactly like the toolbar's Stop button.
bridge.handle('run-config-stop', (_e, { name } = {}) => {
  const launch = readVscodeJson('launch.json') || {};
  const compound = (launch.compounds || []).find((c) => c && c.name === name);
  for (const n of compound ? compoundMembers(compound) : [name]) stopConfigNamed(n);
  return { ok: true };
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
  if (!getRepoPath()) return; // nothing to watch until a folder is opened
  const onChange = () => { sendToRenderer('run-configs-changed'); };
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
