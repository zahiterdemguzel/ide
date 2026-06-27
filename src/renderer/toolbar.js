import { runSpecInConsole } from './consoles.js';
import { isPanelEnabled, onPanelsChanged } from './panels.js';

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
    if (!r || !r.ok) { showRunError((r && r.error) || 'Unknown error while resolving this config.'); return; }
    for (const spec of (r.runs || [])) await runSpecInConsole(spec);
  };
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

export async function loadToolbar() {
  const r = await window.api.getRunConfigs();
  toolbarRuns.innerHTML = '';
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
  for (const c of launch) toolbarRuns.appendChild(runButton('launch', c.name, c.compound));
  // TEMP-FSTEST: auto-run the Fullstack compound when the test workspace is open.
  try {
    const rp = await window.api.getRepoPath();
    const L = (m) => { try { window.api.fstestLog(m); } catch {} };
    L('[FSTEST] loadToolbar repo=' + rp);
    if (rp && /fstest$/.test(rp.replace(/[\\/]+$/, ''))) {
      window.addEventListener('error', (e) => L('[window.error] ' + (e.error && e.error.stack || e.message)));
      window.addEventListener('unhandledrejection', (e) => L('[unhandledrejection] ' + (e.reason && e.reason.stack || e.reason)));
      if (window.__fstestArmed) return; window.__fstestArmed = true; // run once
      L('[FSTEST] autorun armed, repo=' + rp);
      const runOnce = async (tag) => {
        const r = await window.api.runConfig({ kind: 'launch', name: 'Fullstack (Frontend + Backend)' });
        L('[FSTEST] ' + tag + ' runConfig ok=' + (r && r.ok));
        const { runSpecInConsole } = await import('./consoles.js');
        for (const spec of ((r && r.runs) || [])) {
          await runSpecInConsole(spec);
          L('[FSTEST] ' + tag + ' ran ' + spec.name);
        }
      };
      setTimeout(async () => {
        try {
          await runOnce('RUN1');
          L('[FSTEST] RUN1 done, letting output flow 4s');
          setTimeout(async () => {
            try {
              L('[FSTEST] RUN2 (restart, kills live PTYs mid-output)');
              await runOnce('RUN2');
              L('[FSTEST] RUN2 done; waiting to observe');
            } catch (e) { L('[FSTEST] RUN2 error ' + (e && e.stack || e)); }
          }, 4000);
        } catch (e) { L('[FSTEST] RUN1 error ' + (e && e.stack || e)); }
      }, 3000);
    }
  } catch (e) { try { window.api.fstestLog('[FSTEST] outer error ' + (e && e.stack || e)); } catch {} }
  if (launch.length && tasks.length) {
    const sep = document.createElement('span');
    sep.className = 'tool-sep';
    toolbarRuns.appendChild(sep);
  }
  for (const t of tasks) toolbarRuns.appendChild(runButton('task', t.name));
}
