const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { getRepoPath, getMainRepoPath, onRepoChange } = require('./repo');
const { sendToRenderer } = require('./window');
const { cleanEnv } = require('./proc-env');
const { resolveDebugTargets } = require('./run-configs');
const { DapClient } = require('./dap-client');
const {
  attachSocketTarget, pythonCommand, newestBundledDebugpy, shellCommandLine, terminalEnv,
  sourceBreakpoints, defaultExceptionFilters, repoRelative, fileDebugTarget, PASSTHROUGH_REQUESTS,
} = require('./debug-lib');

// --- Debugger: drives debug adapters over DAP (see debug-lib.js) ---
// One entry per live debug session. The renderer owns the UI (gutter
// breakpoints, paused line, call stack, variables, debug console); this module
// owns the adapter process / socket, the launch handshake, and breakpoints.
// Everything the renderer needs to know arrives as `debug-event` pushes.

const sessions = new Map(); // id -> session (see startSession)
let nextSessionId = 1;

// Breakpoints by repo-relative file, as the renderer last sent them. Sent to a
// session during its handshake and re-sent to live sessions on every change.
let breakpointsByFile = new Map();

const ATTACH_RETRY_MS = 500;
const ATTACH_TIMEOUT_MS = 120000; // a Blender/game launch can take a while to open its port

function push(session, kind, payload = {}) {
  sendToRenderer('debug-event', { sessionId: session.id, name: session.name, kind, ...payload });
}

function output(session, text, category = 'console') {
  push(session, 'output', { category, text: text.endsWith('\n') ? text : text + '\n' });
}

function setState(session, state) {
  session.state = state;
  push(session, 'state', {
    state,
    request: session.args.request,
    exceptionFilters: (session.capabilities && session.capabilities.exceptionBreakpointFilters) || [],
    enabledExceptionFilters: session.exceptionFilters,
  });
}

// ── Starting a session ─────────────────────────────────────────────────────

// Run a foreground pre-launch / post-debug task to completion in a hidden shell,
// streaming its output into the debug console. The debugger must wait for it
// (a build step), which a typed-into interactive terminal can't tell us.
function runTaskToExit(session, spec) {
  return new Promise((resolve) => {
    output(session, `> ${spec.name || 'task'}: ${spec.command}`, 'console');
    const child = spawn(spec.command, {
      cwd: spec.cwd || getRepoPath(),
      env: { ...cleanEnv(), ...(spec.env || {}) },
      shell: process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || true),
    });
    child.stdout.on('data', (d) => output(session, d.toString(), 'stdout'));
    child.stderr.on('data', (d) => output(session, d.toString(), 'stderr'));
    child.on('error', (e) => { output(session, e.message, 'stderr'); resolve(1); });
    child.on('close', (code) => resolve(code || 0));
  });
}

// Pre-launch tasks: a background one (a watcher, or the Blender launcher that
// keeps running) gets its own terminal tab and the session goes ahead, as in
// VS Code; a foreground one must finish successfully first.
async function runPreLaunch(session, specs) {
  const background = specs.filter((s) => s.background);
  if (background.length) sendToRenderer('run-specs', { runs: background });
  for (const spec of specs.filter((s) => !s.background)) {
    const code = await runTaskToExit(session, spec);
    if (code !== 0) throw new Error(`preLaunchTask "${spec.name || spec.command}" exited with code ${code}`);
  }
}

// debugpy must be importable by the interpreter. Fall back to the copy the VS
// Code debugpy extension bundles (on PYTHONPATH) before giving up.
function debugpyEnvironment(python) {
  const env = cleanEnv();
  const probe = spawnSync(python[0], [...python.slice(1), '-c', 'import debugpy'], { env, timeout: 15000 });
  if (probe.status === 0) return env;
  const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
  let folders = [];
  try { folders = fs.readdirSync(extensionsDir); } catch { /* no VS Code install */ }
  const bundled = newestBundledDebugpy(extensionsDir, folders);
  if (bundled && fs.existsSync(path.join(bundled, 'debugpy'))) {
    env.PYTHONPATH = env.PYTHONPATH ? `${bundled}${path.delimiter}${env.PYTHONPATH}` : bundled;
    return env;
  }
  if (probe.error) throw new Error(`Couldn't run Python (${python.join(' ')}): ${probe.error.message}`);
  throw new Error(`debugpy isn't installed for ${python.join(' ')}. Install it with: ${python.join(' ')} -m pip install debugpy`);
}

// Spawn `python -m debugpy.adapter`, which speaks DAP on stdio.
function spawnDebugpyAdapter(session) {
  const repo = getRepoPath();
  const python = pythonCommand(session.args, repo, process.platform, fs.existsSync);
  const env = debugpyEnvironment(python);
  // The debuggee should run on the same interpreter we found (the project's
  // .venv), as VS Code does with its selected interpreter.
  if (session.args.request === 'launch' && !session.args.python && !session.args.pythonPath) session.args.python = python;
  const proc = spawn(python[0], [...python.slice(1), '-m', 'debugpy.adapter'], { cwd: repo, env });
  proc.stderr.on('data', (d) => output(session, d.toString(), 'stderr'));
  proc.on('error', (e) => output(session, `Debug adapter failed: ${e.message}`, 'stderr'));
  session.proc = proc;
  session.client.connect(proc.stdout, proc.stdin);
}

// Connect to a debugpy server that is (or will soon be) listening — retrying
// while the pre-launch task is still starting the target process.
async function connectSocket(session, { host, port }) {
  output(session, `Waiting for debugpy on ${host}:${port}…`);
  const deadline = Date.now() + ATTACH_TIMEOUT_MS;
  for (;;) {
    if (session.state === 'ended') throw new Error('Stopped');
    const socket = await new Promise((resolve) => {
      const s = net.connect({ host, port });
      s.once('connect', () => resolve(s));
      s.once('error', () => { s.destroy(); resolve(null); });
    });
    if (socket) {
      session.socket = socket;
      session.client.connect(socket, socket);
      return;
    }
    if (Date.now() > deadline) throw new Error(`Nothing is listening on ${host}:${port} (gave up after ${ATTACH_TIMEOUT_MS / 1000}s)`);
    await new Promise((r) => setTimeout(r, ATTACH_RETRY_MS));
  }
}

function waitForEvent(client, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = (msg) => { if (msg.event === eventName) { cleanup(); resolve(msg); } };
    const onClose = () => { cleanup(); reject(new Error('Debug adapter exited during startup')); };
    const cleanup = () => { client.off('event', onEvent); client.off('close', onClose); };
    client.on('event', onEvent);
    client.on('close', onClose);
  });
}

// The DAP startup handshake, in the order VS Code performs it: initialize →
// launch/attach (answered only after configurationDone) → on `initialized`,
// breakpoints + exception filters → configurationDone.
async function handshake(session) {
  const { client, args } = session;
  session.capabilities = await client.request('initialize', {
    clientID: 'ide', clientName: 'IDE', adapterID: session.adapter, pathFormat: 'path',
    linesStartAt1: true, columnsStartAt1: true, locale: 'en',
    supportsVariableType: true, supportsVariablePaging: false, supportsRunInTerminalRequest: true,
    supportsProgressReporting: false, supportsInvalidatedEvent: false, supportsStartDebuggingRequest: false,
  });
  session.exceptionFilters = defaultExceptionFilters(session.capabilities);
  const initialized = waitForEvent(client, 'initialized');
  const started = client.request(args.request, args, 0);
  started.catch(() => {}); // surfaced below; don't leave it unhandled during the race
  await Promise.race([initialized, started]);
  for (const file of breakpointsByFile.keys()) await sendBreakpoints(session, file);
  await client.request('setExceptionBreakpoints', { filters: session.exceptionFilters });
  if (session.capabilities.supportsConfigurationDoneRequest) await client.request('configurationDone', {});
  await started;
}

function wireClient(session) {
  const { client } = session;
  client.on('event', (msg) => onAdapterEvent(session, msg));
  client.on('request', (req) => onReverseRequest(session, req));
  client.on('close', () => endSession(session));
}

function onAdapterEvent(session, msg) {
  const body = msg.body || {};
  switch (msg.event) {
    case 'output':
      if (body.category !== 'telemetry' && body.output) output(session, body.output, body.category || 'console');
      break;
    case 'stopped':
      session.state = 'paused';
      push(session, 'stopped', body);
      break;
    case 'continued':
      session.state = 'running';
      push(session, 'continued', body);
      break;
    case 'exited':
      output(session, `Process exited with code ${body.exitCode}`);
      break;
    case 'terminated':
      endSession(session);
      break;
    case 'breakpoint':
      push(session, 'breakpoint', body);
      break;
  }
}

// The adapter asking us to do something. debugpy's launch asks for a terminal
// to run the program in — an in-app terminal tab named after the config, so the
// toolbar's running indicator lights up as for a plain run.
function onReverseRequest(session, req) {
  if (req.command === 'runInTerminal') {
    const a = req.arguments || {};
    sendToRenderer('run-specs', {
      runs: [{ command: shellCommandLine(a.args || [], process.platform), cwd: a.cwd || getRepoPath(), env: terminalEnv(a.env), name: session.name }],
    });
    session.client.respond(req, {});
    return;
  }
  session.client.respond(req, null, `"${req.command}" is not supported by this IDE`);
}

async function startSession(target, group) {
  const session = {
    // The tree it started in: in worktree mode the active tree follows the
    // selected Claude session, but this debuggee's files stay where they are.
    repo: getRepoPath(),
    id: nextSessionId++, name: target.name, adapter: target.adapter, args: target.args,
    postRuns: target.postRuns, group, client: new DapClient(), proc: null, socket: null,
    capabilities: null, exceptionFilters: [], state: 'starting',
  };
  sessions.set(session.id, session);
  setState(session, 'starting');
  try {
    await runPreLaunch(session, target.preRuns);
    wireClient(session);
    const socketTarget = attachSocketTarget(session.args);
    if (socketTarget) await connectSocket(session, socketTarget);
    else spawnDebugpyAdapter(session);
    await handshake(session);
    if (session.state === 'starting') setState(session, 'running');
  } catch (e) {
    if (session.state !== 'ended') {
      output(session, e.message, 'stderr');
      push(session, 'error', { message: e.message });
      endSession(session);
    }
  }
  return session;
}

// ── Ending a session ───────────────────────────────────────────────────────

function endSession(session) {
  if (session.state === 'ended') return;
  session.state = 'ended';
  sessions.delete(session.id);
  try { session.client.close(); } catch { /* already closed */ }
  if (session.socket) session.socket.destroy();
  if (session.proc && session.proc.exitCode == null) session.proc.kill();
  push(session, 'ended');
  // postDebugTask: cleanup that runs whatever happened, in a terminal tab.
  if (session.postRuns && session.postRuns.length) sendToRenderer('run-specs', { runs: session.postRuns });
  // A compound with `stopAll` ends together: one member stopping stops the rest.
  if (session.group && session.group.stopAll) {
    for (const other of [...sessions.values()]) if (other.group === session.group) stopSession(other);
  }
}

async function stopSession(session) {
  if (!session || session.state === 'ended') return;
  // A launched program is ours to end; an attached one (Blender) keeps running.
  const terminateDebuggee = session.args.request === 'launch';
  // Still waiting for a socket (attach retry loop): there's no one to tell.
  if (!session.client.closed && session.client.writable) {
    await session.client.request('disconnect', { restart: false, terminateDebuggee }, 3000).catch(() => {});
  }
  endSession(session);
}

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle('debug-start', (_e, { name, inputs, editor } = {}) => {
  const r = resolveDebugTargets({ name, inputs, editor });
  if (!r.ok) return r;
  const group = { stopAll: r.stopAll };
  for (const target of r.targets) startSession(target, group);
  // Non-debuggable compound members still run, as terminal commands.
  return { ok: true, runs: r.runs };
});

// The editor's "Debug this file" for a Python file (repo-relative `file`).
ipcMain.handle('debug-start-file', (_e, { file, python } = {}) => {
  const repo = getRepoPath();
  if (!repo || !file) return { ok: false, error: 'No file open' };
  const abs = path.isAbsolute(file) ? file : path.join(repo, file);
  startSession(fileDebugTarget(abs, repo, python), { stopAll: false });
  return { ok: true };
});

ipcMain.handle('debug-stop', async (_e, { sessionId } = {}) => {
  const targets = sessionId == null ? [...sessions.values()] : [sessions.get(sessionId)];
  await Promise.all(targets.map(stopSession));
  return { ok: true };
});

// Stepping and inspection, forwarded as-is (allowlisted). Stack frames get the
// repo-relative path the editor opens.
ipcMain.handle('debug-request', async (_e, { sessionId, command, args } = {}) => {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'No such debug session' };
  if (!PASSTHROUGH_REQUESTS.has(command)) return { ok: false, error: `"${command}" is not allowed` };
  // Resuming is announced before the request goes out: the adapter may report
  // the next `stopped` before it answers, and that must win.
  if (command === 'continue' || command === 'next' || command === 'stepIn' || command === 'stepOut') {
    session.state = 'running';
    push(session, 'continued', { threadId: args && args.threadId, allThreadsContinued: true });
  }
  try {
    const body = await session.client.request(command, args || {});
    if (command === 'stackTrace') {
      for (const frame of body.stackFrames || []) {
        if (frame.source && frame.source.path) frame.source.rel = repoRelative(session.repo, frame.source.path);
      }
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function sendBreakpoints(session, file) {
  const list = breakpointsByFile.get(file) || [];
  const abs = path.join(session.repo, file);
  try {
    const body = await session.client.request('setBreakpoints', {
      source: { path: abs, name: path.basename(abs) },
      breakpoints: sourceBreakpoints(list),
      lines: list.map((bp) => bp.line),
    });
    push(session, 'breakpoints', { file, breakpoints: body.breakpoints || [] });
  } catch (e) {
    output(session, `Couldn't set breakpoints in ${file}: ${e.message}`, 'stderr');
  }
}

// The renderer's breakpoint list for one file (or, with `all`, every file —
// sent once at startup and on folder change). Re-sent to every live session.
ipcMain.handle('debug-set-breakpoints', async (_e, { file, breakpoints, all } = {}) => {
  const changed = [];
  if (all) {
    const previous = [...breakpointsByFile.keys()];
    breakpointsByFile = new Map(Object.entries(all));
    changed.push(...new Set([...previous, ...breakpointsByFile.keys()]));
  } else if (file) {
    if (breakpoints && breakpoints.length) breakpointsByFile.set(file, breakpoints);
    else breakpointsByFile.delete(file);
    changed.push(file);
  }
  for (const session of sessions.values()) {
    if (session.state === 'starting') continue; // the handshake sends the current set
    for (const f of changed) await sendBreakpoints(session, f);
  }
  return { ok: true };
});

ipcMain.handle('debug-set-exception-filters', async (_e, { sessionId, filters } = {}) => {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'No such debug session' };
  session.exceptionFilters = filters || [];
  try {
    await session.client.request('setExceptionBreakpoints', { filters: session.exceptionFilters });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Opening another project ends every session: their breakpoints and paths
// belong to the old one. Selecting a worktree session only moves the active
// tree, which must not kill a debuggee (the consoles survive it the same way).
let debugProject = getMainRepoPath();
onRepoChange(() => {
  if (getMainRepoPath() === debugProject) return;
  debugProject = getMainRepoPath();
  for (const s of [...sessions.values()]) stopSession(s);
});

function stopAllDebugSessions() {
  for (const s of [...sessions.values()]) endSession(s);
}

module.exports = { stopAllDebugSessions };
