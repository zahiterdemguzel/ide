import { runSpecInConsole } from './consoles.js';

// --- top run toolbar (.vscode/launch.json + tasks.json) ---
// One button per launch config, a separator, then one per task. Clicking a button
// runs that config/task in a git-pane terminal tab (main resolves the command);
// relaunching reuses its existing tab. Rebuilt on startup and on open-folder.
const toolbarRuns = document.getElementById('toolbar-runs');

function runButton(kind, name, compound) {
  const b = document.createElement('button');
  b.className = 'tool-btn ' + kind;
  b.title = (kind === 'launch' ? (compound ? 'Launch compound: ' : 'Launch: ') : 'Task: ')
    + name + ' — runs in a terminal panel';
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
    if (!r || !r.ok) { console.error('run-config failed:', (r && r.error) || 'unknown'); return; }
    for (const spec of (r.runs || [])) await runSpecInConsole(spec);
  };
  return b;
}

export async function loadToolbar() {
  const r = await window.api.getRunConfigs();
  toolbarRuns.innerHTML = '';
  const launch = r.launch || [], tasks = r.tasks || [];
  if (!launch.length && !tasks.length) {
    const hint = document.createElement('span');
    hint.className = 'toolbar-hint';
    hint.textContent = 'No .vscode/launch.json or tasks.json in this folder';
    toolbarRuns.appendChild(hint);
    return;
  }
  for (const c of launch) toolbarRuns.appendChild(runButton('launch', c.name, c.compound));
  if (launch.length && tasks.length) {
    const sep = document.createElement('span');
    sep.className = 'tool-sep';
    toolbarRuns.appendChild(sep);
  }
  for (const t of tasks) toolbarRuns.appendChild(runButton('task', t.name));
}
