import { runSpecInConsole, runningConfigNames, onConsolesChanged } from './consoles.js';
import { isPanelEnabled, onPanelsChanged } from './panels.js';

// --- top run toolbar (.vscode/launch.json + tasks.json) ---
// One button per launch config, a separator, then one per task. Clicking a button
// runs that config/task in a git-pane terminal tab (main resolves the command);
// relaunching reuses its existing tab. Rebuilt on startup and on open-folder.
const toolbarRuns = document.getElementById('toolbar-runs');

// Launch buttons whose icon flips play -> restart while their terminal is alive.
// Each entry: { btn, ico, name, compound, members }.
let launchButtons = [];

// A launch config "runs" as long as the terminal it started is still open; a
// compound runs if any of its referenced configs' terminals are alive.
function launchRunning(entry, live) {
  return entry.compound ? entry.members.some((m) => live.has(m)) : live.has(entry.name);
}

// Reflect each launch button's live state: restart icon (↻) while running, play
// (▶) when idle. Driven by console open/close events plus a 10s safety poll.
function refreshRunStates() {
  const live = runningConfigNames();
  for (const e of launchButtons) {
    const running = launchRunning(e, live);
    e.ico.textContent = running ? '↻' : '▶';
    e.btn.classList.toggle('running', running);
    e.btn.title = (running ? (e.compound ? 'Restart compound: ' : 'Restart: ')
      : (e.compound ? 'Launch compound: ' : 'Launch: '))
      + e.name + (running ? ' — restarts its terminal' : ' — runs in a terminal panel');
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
    const r = await window.api.runConfig({ kind, name });
    b.classList.remove('busy');
    if (!r || !r.ok) { showRunError((r && r.error) || 'Unknown error while resolving this config.'); return; }
    for (const spec of (r.runs || [])) await runSpecInConsole(spec);
  };
  if (kind === 'launch') launchButtons.push({ btn: b, ico, name, compound: !!compound, members: members || [] });
  else b.title = 'Task: ' + name + ' — runs in a terminal panel';
  return b;
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
