import { runSpecInConsole, runningConfigNames, stopConfig, onConsolesChanged } from './consoles.js';
import { isPanelEnabled, onPanelsChanged } from './panels.js';
import { promptText } from './shared/prompt.js';
import { getActiveFile } from './viewer/file.js';

// --- top run toolbar (.vscode/launch.json + tasks.json) ---
// One button per launch config, a separator, then one per task. Clicking a button
// runs that config/task in a git-pane terminal tab (main resolves the command);
// relaunching reuses its existing tab. Rebuilt on startup and on open-folder.
const toolbarRuns = document.getElementById('toolbar-runs');

// Launch buttons whose icon flips play -> restart while their terminal is alive.
// Each entry: { btn, ico, stop, name, compound, members }.
let launchButtons = [];

// A bold circular-arrow restart glyph as inline SVG — the Unicode ↻ renders too
// thin and varies by font, so we draw it with a heavy stroke instead. Uses
// currentColor so the existing green/yellow/hover tinting still applies.
const RESTART_SVG = '<svg class="ico-svg" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M20 11.5a8 8 0 1 1-2.3-5.4"/><path d="M20 3.5v5h-5"/></svg>';

// A launch config "runs" as long as the terminal it started is still open; a
// compound runs if any of its referenced configs' terminals are alive.
function launchRunning(entry, live) {
  return entry.compound ? entry.members.some((m) => live.has(m)) : live.has(entry.name);
}

// Reflect each launch button's live state: a bold restart glyph while running,
// play (▶) when idle. Driven by console open/close events plus a 10s safety poll.
function refreshRunStates() {
  const live = runningConfigNames();
  for (const e of launchButtons) {
    const running = launchRunning(e, live);
    if (running) e.ico.innerHTML = RESTART_SVG;
    else e.ico.textContent = '▶';
    e.btn.classList.toggle('running', running);
    e.btn.title = (running ? (e.compound ? 'Restart compound: ' : 'Restart: ')
      : (e.compound ? 'Launch compound: ' : 'Launch: '))
      + e.name + (running ? ' — restarts its terminal' : ' — runs in a terminal panel');
    // The Stop button only appears (animating in over its reserved space) while
    // the config's terminal is alive; idle it stays hidden but keeps its slot.
    e.stop.classList.toggle('visible', running);
  }
}

function runButton(kind, name, compound, members) {
  const b = document.createElement('button');
  b.className = 'tool-btn ' + kind;
  const ico = document.createElement('span');
  ico.className = 'tool-ico';
  ico.textContent = kind === 'launch' ? '▶' : '⚙';
  const label = document.createElement('span');
  label.textContent = name;
  b.append(ico, label);
  b.onclick = async () => {
    b.classList.add('busy');
    let r = await window.api.runConfig({ kind, name, activeFile: getActiveFile() });
    // The config uses ${input:...} variables: collect the answers (VS Code's
    // `inputs` prompts), then resolve again with them filled in.
    if (r && r.needsInputs) {
      const inputs = await collectInputs(name, r.needsInputs);
      if (!inputs) { b.classList.remove('busy'); return; } // user cancelled
      r = await window.api.runConfig({ kind, name, inputs, activeFile: getActiveFile() });
    }
    b.classList.remove('busy');
    if (!r || !r.ok) { showRunError((r && r.error) || 'Unknown error while resolving this config.'); return; }
    for (const spec of (r.runs || [])) await runSpecInConsole(spec);
  };
  if (kind !== 'launch') { b.title = 'Task: ' + name + ' — runs in a terminal panel'; return b; }

  // A launch config carries a Stop button to its left. Its space is always
  // reserved in the group (fixed width), so it can animate in/out as the config
  // starts/stops without shifting the launch button or anything after it. A
  // compound stops each of its referenced configs' terminals.
  const group = document.createElement('span');
  group.className = 'launch-group';
  const stop = document.createElement('button');
  stop.className = 'launch-stop';
  stop.title = 'Stop: ' + name;
  stop.setAttribute('aria-label', 'Stop ' + name);
  const stopNames = compound ? (members || []) : [name];
  stop.onclick = (e) => { e.stopPropagation(); for (const n of stopNames) stopConfig(n); };
  group.append(stop, b);
  launchButtons.push({ btn: b, ico, stop, name, compound: !!compound, members: members || [] });
  return group;
}

// Ask the user for each ${input:...} the config declared: promptString via the
// shared text prompt, pickString via a small option-list modal. Returns the
// { id: value } map, or null if any prompt is cancelled.
async function collectInputs(configName, needs) {
  const values = {};
  for (const inp of needs) {
    const v = inp.type === 'pickString'
      ? await pickOption({ title: configName, label: inp.description, options: inp.options || [], def: inp.default })
      : await promptText({ title: configName, label: inp.description, value: inp.default || '', ok: 'Run' });
    if (v == null) return null;
    values[inp.id] = v;
  }
  return values;
}

// A minimal pickString modal: one button per option (options may be plain strings
// or { label, value }), Escape/backdrop cancels. Resolves to the picked value.
function pickOption({ title, label, options, def }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal';
    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = title || '';
    const labelEl = document.createElement('div');
    labelEl.className = 'modal-label';
    labelEl.textContent = label || '';
    box.append(titleEl, labelEl);
    function close(result) {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }
    for (const opt of options) {
      const value = typeof opt === 'object' && opt !== null ? opt.value : opt;
      const text = typeof opt === 'object' && opt !== null ? (opt.label || opt.value) : opt;
      const btn = document.createElement('button');
      btn.className = 'modal-ok pick-option';
      btn.textContent = text + (value === def ? ' (default)' : '');
      btn.onclick = () => close(value);
      box.appendChild(btn);
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'modal-cancel';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => close(null);
    actions.appendChild(cancel);
    box.appendChild(actions);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
    window.addEventListener('keydown', onKey, true);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  });
}

// A config the app can't translate into a terminal command (e.g. a browser/attach
// launch config) surfaces here instead of failing silently in the dev console.
function showRunError(message) {
  document.getElementById('run-error-msg').textContent = message;
  document.getElementById('run-error-dialog').showModal();
}
document.getElementById('run-error-ok').onclick = () =>
  document.getElementById('run-error-dialog').close();

// Main watches .vscode/launch.json + tasks.json and pushes this when either
// changes (created/edited/deleted), so the buttons track the files live.
window.api.onRunConfigsChanged(() => loadToolbar());

// Re-render when the Launch/Tasks visibility toggles change.
onPanelsChanged(() => loadToolbar());

// Flip icons the moment a config terminal opens/closes, plus a 10s safety poll
// in case a console lifecycle event is ever missed.
onConsolesChanged(refreshRunStates);
setInterval(refreshRunStates, 10000);

export async function loadToolbar() {
  const r = await window.api.getRunConfigs();
  toolbarRuns.innerHTML = '';
  launchButtons = [];
  const rawLaunch = r.launch || [], rawTasks = r.tasks || [];
  if (!rawLaunch.length && !rawTasks.length) {
    const hint = document.createElement('span');
    hint.className = 'toolbar-hint';
    hint.textContent = 'No .vscode/launch.json or tasks.json in this folder';
    toolbarRuns.appendChild(hint);
    return;
  }
  // The folder has configs, but the user may have hidden one or both groups.
  const launch = isPanelEnabled('launch') ? rawLaunch : [];
  const tasks = isPanelEnabled('tasks') ? rawTasks : [];
  for (const c of launch) toolbarRuns.appendChild(runButton('launch', c.name, c.compound, c.members));
  if (launch.length && tasks.length) {
    const sep = document.createElement('span');
    sep.className = 'tool-sep';
    toolbarRuns.appendChild(sep);
  }
  for (const t of tasks) toolbarRuns.appendChild(runButton('task', t.name));
  refreshRunStates();
}
