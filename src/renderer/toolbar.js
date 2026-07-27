import { runSpecInConsole, runningConfigNames, stopConfig, onConsolesChanged } from './consoles.js';
import { isPanelEnabled, onPanelsChanged } from './panels.js';
import { promptText, pickOption } from './shared/prompt.js';
import { showError } from './shared/warn.js';
import { getEditorContext } from './viewer/file.js';
import { newSessionWithPrompt } from './sessions.js';

// Sent to a fresh session when the folder has no run configs yet. Deliberately
// stack-agnostic — it tells the session to derive everything from the project's
// own manifests/scripts — and it spells out what this app's translator actually
// supports, since we run each entry as a terminal command line and have no
// debugger or extension host. Keep in sync with run-configs-lib.js.
const CREATE_RUN_CONFIGS_PROMPT = [
  'Set up VS Code run configurations for this project so its build/run/test commands are one click away',
  'in this IDE\'s top toolbar.',
  '',
  'HOW THIS IDE RUNS THEM (important — it is not VS Code):',
  'Every launch config and task is translated into a single shell command line and run in an in-app',
  'terminal tab. There is no debugger and no extension host, so write configs that are correct as',
  '*commands*, not just as debug sessions.',
  '- Supported launch types (a runnable command is derived from the config): node / node-terminal,',
  '  python / debugpy (program, module or code), java, go, coreclr / clr / dotnet, dart / flutter, bun,',
  '  powershell, mix_task, r-debugger, rdbg, lua-local, extensionHost, godot, gdb / lldb-mi (via "target"),',
  '  any type carrying a "cargo" object (Rust via CodeLLDB/cppdbg), the simple interpreter types',
  '  php/ruby/perl/lua/julia/mojo/bashdb/shell, and browser types (chrome/msedge/firefox/pwa-*), which',
  '  just open their "url" or "file" in the default browser.',
  '- Any other type still works if it has a "program" and/or "runtimeExecutable" — that is the fallback.',
  '- NOT supported: "request": "attach" (nothing to run — always use "request": "launch"), breakpoints,',
  '  and ${command:...} variables (the user gets prompted to type the value instead — avoid them).',
  '- Supported task types: shell and process, plus npm, typescript, gulp, grunt and jake. Anything else',
  '  needs an explicit "command". Problem matchers are ignored, so do not rely on them.',
  '- Also honoured: compounds, dependsOn / dependsOrder ("sequence" chains in one terminal, otherwise one',
  '  terminal each), preLaunchTask / postDebugTask, isBackground (watchers get their own terminal),',
  '  options.cwd / options.env / options.shell, envFile, per-platform "windows"/"osx"/"linux" override',
  '  blocks, a tasks.json top-level "options", serverReadyAction, runOptions.runOn "folderOpen",',
  '  presentation.hidden / presentation.order, and "inputs" of type promptString and pickString only.',
  '- Supported variables: ${workspaceFolder}, ${workspaceFolderBasename}, ${userHome}, ${pathSeparator},',
  '  ${defaultBuildTask}, ${execPath}, ${env:VAR}, ${config:some.setting}, ${input:id}, and the ${file}',
  '  family (${file}, ${fileBasename}, ${fileDirname}, ${relativeFile}, ...), which resolve against the',
  '  file open in the editor — so only use those in configs meant to run the current file.',
  '- Entry names must be unique within launch.json and within tasks.json — runs are addressed by name.',
  '- The shell is the platform default (PowerShell on Windows), so a shell task\'s command line must be',
  '  valid there; use the "windows"/"osx"/"linux" override blocks when a command differs per platform.',
  '- npm scripts in package.json are already auto-detected as "npm: <script>" buttons. Do not duplicate',
  '  them in tasks.json unless you need to customize one (cwd, env, dependsOn).',
  '',
  'WHAT TO DO:',
  '1. Identify the project. Look at the repo root and any obvious subprojects for manifests and scripts',
  '   (e.g. package.json, pyproject.toml/requirements.txt, Cargo.toml, go.mod, pom.xml/build.gradle,',
  '   *.csproj/*.sln, Makefile/CMakeLists.txt, Dockerfile/compose files, CI workflows, README).',
  '   Use what you find to determine the real entry points, package manager, and existing scripts.',
  '   Do not guess a stack or invent commands that are not in the project.',
  '',
  '2. Write .vscode/tasks.json with one task per command the project actually supports — typically build,',
  '   run/dev/start, test, and lint. Prefer invoking the project\'s own scripts (make <target>, cargo <cmd>,',
  '   uv run ..., ...) over hand-rolled command lines. Give each task a short, clear label, set "type"',
  '   ("shell" unless you need "process"), set "group" for build and test tasks, set "options.cwd" when a',
  '   task belongs to a subdirectory, and set "isBackground": true for watchers and dev servers.',
  '',
  '3. Write .vscode/launch.json with one "request": "launch" configuration per thing the project actually',
  '   runs (app entry point, server, CLI, test suite), using a type from the supported list above. Point',
  '   "program"/"args"/"cwd" at real files and directories, use ${workspaceFolder} for paths, and wire',
  '   "preLaunchTask" to the matching build task when a build step is required. If nothing in the project',
  '   is launchable this way, skip launch.json rather than inventing a configuration.',
  '',
  '4. If either file already exists, merge into it instead of overwriting, and keep existing entries intact.',
  '',
  '5. Verify: the JSON must parse (// and /* */ comments and trailing commas are fine — this app reads',
  '   JSONC), every referenced path must exist, and every command must be one that actually runs in this',
  '   project on this platform. Run each one once to confirm it starts, then tell me the list of launch',
  '   configs and tasks you created — they appear as toolbar buttons as soon as the files are saved.',
].join('\n');

// --- top run toolbar (.vscode/launch.json + tasks.json) ---
// One button per launch config, a separator, then one per task. Clicking a button
// runs that config/task in a git-pane terminal tab (main resolves the command);
// relaunching reuses its existing tab. Rebuilt on startup and on open-folder.
const toolbarRuns = document.getElementById('toolbar-runs');

// Each group (launch configs, tasks) lives in its own strip that scrolls
// horizontally (hidden scrollbar) when it overflows, so scrolling one group
// never moves the other. A plain mouse wheel only emits vertical deltas —
// translate those into scrollLeft on whichever strip the pointer is over.
toolbarRuns.addEventListener('wheel', (e) => {
  const strip = e.target.closest('.run-strip');
  if (!strip || !e.deltaY || e.deltaX) return; // trackpad horizontal swipes already work
  strip.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

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
    const editor = getEditorContext();
    let r = await window.api.runConfig({ kind, name, editor });
    // The config uses ${input:...} (or ${command:...}) variables: collect the
    // answers — VS Code's `inputs` prompts — then resolve again with them filled in.
    if (r && r.needsInputs) {
      const inputs = await collectInputs(name, r.needsInputs);
      if (!inputs) { b.classList.remove('busy'); return; } // user cancelled
      r = await window.api.runConfig({ kind, name, inputs, editor });
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

// VS Code's `runOptions.runOn: "folderOpen"`: tasks the project asks to start as
// soon as it's opened. Main resolves but never runs them — opening someone's repo
// shouldn't silently execute commands it chose — so we ask first, once per folder
// (loadToolbar also reruns on file edits and panel toggles, hence the repo guard).
let autoTasksOfferedFor = null;
async function offerAutoTasks() {
  const r = await window.api.getAutoTasks();
  if (!r || !r.runs || !r.runs.length || r.repo === autoTasksOfferedFor) return;
  autoTasksOfferedFor = r.repo;
  const choice = await pickOption({
    title: 'Automatic tasks',
    label: `This folder's tasks.json asks to start ${r.names.join(', ')} on open. Run ${r.names.length > 1 ? 'them' : 'it'}?`,
    options: ['Run', 'Skip'],
    def: 'Skip',
  });
  if (choice === 'Run') for (const spec of r.runs) await runSpecInConsole(spec);
}

// A config the app can't translate into a terminal command (e.g. a browser/attach
// launch config) surfaces here instead of failing silently in the dev console.
function showRunError(message) {
  showError(message, "Can't run this config", { mono: false });
}

// Main watches .vscode/launch.json + tasks.json and pushes this when either
// changes (created/edited/deleted), so the buttons track the files live.
window.api.onRunConfigsChanged(() => loadToolbar());

// A paired phone asked to run a config/task. Main resolved it and handed us the
// specs: open them exactly as a toolbar click would (same tab reuse, so a rerun
// from the phone restarts the tab that's already here).
window.api.onRunSpecs(({ runs }) => {
  for (const spec of runs || []) runSpecInConsole(spec);
});

// Re-render when the Launch/Tasks visibility toggles change.
onPanelsChanged(() => loadToolbar());

// Flip icons the moment a config terminal opens/closes, plus a 10s safety poll
// in case a console lifecycle event is ever missed.
onConsolesChanged(refreshRunStates);
setInterval(refreshRunStates, 10000);

export async function loadToolbar() {
  const r = await window.api.getRunConfigs();
  offerAutoTasks();
  toolbarRuns.innerHTML = '';
  launchButtons = [];
  const rawLaunch = r.launch || [], rawTasks = r.tasks || [];
  if (!rawLaunch.length && !rawTasks.length) {
    const hint = document.createElement('span');
    hint.className = 'toolbar-hint';
    hint.textContent = 'No .vscode/launch.json or tasks.json in this folder';
    toolbarRuns.appendChild(hint);
    // With no folder open there is nowhere to write the files, so the button is
    // inert until one is opened (opening a folder re-runs loadToolbar).
    let repo = '';
    try { repo = await window.api.getRepoPath(); } catch { /* no folder open */ }
    const cta = document.createElement('button');
    cta.className = 'tool-btn toolbar-cta';
    cta.textContent = 'Create run configs';
    cta.disabled = !repo;
    cta.title = repo
      ? 'Ask a new session to write .vscode/launch.json and tasks.json for this project'
      : 'Open a folder first';
    cta.onclick = () => newSessionWithPrompt(CREATE_RUN_CONFIGS_PROMPT);
    toolbarRuns.appendChild(cta);
    return;
  }
  // The folder has configs, but the user may have hidden one or both groups.
  const launch = isPanelEnabled('launch') ? rawLaunch : [];
  const tasks = isPanelEnabled('tasks') ? rawTasks : [];
  if (launch.length) {
    const strip = document.createElement('div');
    strip.className = 'run-strip';
    for (const c of launch) strip.appendChild(runButton('launch', c.name, c.compound, c.members));
    toolbarRuns.appendChild(strip);
  }
  if (launch.length && tasks.length) {
    const sep = document.createElement('span');
    sep.className = 'tool-sep';
    toolbarRuns.appendChild(sep);
  }
  if (tasks.length) {
    const strip = document.createElement('div');
    strip.className = 'run-strip';
    for (const t of tasks) strip.appendChild(runButton('task', t.name));
    toolbarRuns.appendChild(strip);
  }
  refreshRunStates();
}
