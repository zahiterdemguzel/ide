const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { sendToRenderer } = require('./window');
const {
  encodeMessage, createMessageReader, serverKey, resolveLaunch,
  extraSearchDirs, searchDirs, findExecutable,
  unpackedPath, serverEnv, spawnInvocation, findVenvPython, serverSettings,
} = require('./lsp-lib');

// --- Language servers: the process host (see lsp-lib.js) ---
// A near-dumb pipe. It starts one server per (server, project root), forwards
// framed JSON-RPC between the server and the renderer, and reports exits. The
// renderer's editor/lsp-client.js does everything protocol-level (initialize,
// requests, shutdown), so this module never parses a message body.
//
// IPC:
//   lsp-ensure {languageId, root}  → {ok, key, serverId, name, languages, settings,
//                                     initializationOptions?, reused}
//                                   | {ok:false, reason, unknown}  (unknown: no server exists for the language)
//   lsp-send   {key, message}       (fire-and-forget; message is a JSON string)
//   lsp-stop   {key}  /  lsp-stop-all
//   → renderer: lsp-message {key, message}, lsp-exit {key, code, signal, error}

const servers = new Map(); // key -> live connection { key, serverId, write, kill, stderrTail }
const starting = new Map(); // key -> Promise of the ensure result, while spawning

const STOP_GRACE_MS = 1500; // time for a server to exit on its own after `exit`
const STDERR_LOG_LIMIT = 64 * 1024; // per server; a chatty server mustn't flood the console
const STDERR_TAIL = 4 * 1024; // kept for the exit report
const TCP_CONNECT_TIMEOUT_MS = 1500;

// ── Locating executables ────────────────────────────────────────────────────

function bundledPath(relative) {
  const full = unpackedPath(path.join(app.getAppPath(), 'node_modules', relative));
  return fs.existsSync(full) ? full : null;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// The user's login-shell PATH, read once (see extraSearchDirs for why a GUI app
// needs it) — shared with the Claude CLI lookup (shell-path.js).
const { loginShellPath } = require('./shell-path');

function currentSearchDirs(loginPath) {
  return searchDirs({
    envPath: process.env.PATH || process.env.Path,
    loginShellPath: loginPath,
    extra: extraSearchDirs({ home: os.homedir(), platform: process.platform, env: process.env }),
    platform: process.platform,
  });
}

function launchContext(root, dirs) {
  return {
    which: (cmd) => findExecutable(cmd, dirs, { platform: process.platform, isFile: isExecutableFile, pathext: process.env.PATHEXT }),
    bundled: bundledPath,
    exists: (p) => fs.existsSync(p),
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    root,
    cacheDir: path.join(app.getPath('userData'), 'lsp-cache'),
  };
}

// Bundled servers resolve without waiting on the login shell; anything looked up
// on PATH waits for it, because that's exactly what a Finder-launched app lacks.
async function planLaunch(languageId, root) {
  const quickDirs = currentSearchDirs(null);
  const quick = resolveLaunch(languageId, launchContext(root, quickDirs));
  if (quick.ok && quick.source !== 'path') return { plan: quick, dirs: quickDirs };
  const dirs = currentSearchDirs(await loginShellPath());
  return { plan: resolveLaunch(languageId, launchContext(root, dirs)), dirs };
}

// ── Transports ──────────────────────────────────────────────────────────────
// A connection only speaks for its key while it is the registered one: a stopped
// server that is still winding down (or a stale exit) must not affect a fresh
// server that has since started under the same key.

function isCurrent(connection) {
  return servers.get(connection.key) === connection;
}

function forwardFrom(connection) {
  return createMessageReader((message) => {
    if (isCurrent(connection)) sendToRenderer('lsp-message', { key: connection.key, message });
  });
}

function reportExit(connection, code, signal, error) {
  if (!isCurrent(connection)) return;
  servers.delete(connection.key);
  const tail = connection.stderrTail.trim();
  const detail = error || (code ? tail.slice(-600) : '') || null;
  sendToRenderer('lsp-exit', { key: connection.key, code, signal, error: detail });
}

function logStderr(connection, text) {
  connection.stderrTail = (connection.stderrTail + text).slice(-STDERR_TAIL);
  if (connection.stderrLogged >= STDERR_LOG_LIMIT) return;
  connection.stderrLogged += text.length;
  console.log(`[lsp:${connection.serverId}] ${text.trimEnd()}`);
  if (connection.stderrLogged >= STDERR_LOG_LIMIT) console.log(`[lsp:${connection.serverId}] (further stderr suppressed)`);
}

function newConnection(key, serverId) {
  return { key, serverId, stderrTail: '', stderrLogged: 0, write: null, kill: null };
}

function spawnStdio(key, plan, root, dirs) {
  return new Promise((resolve) => {
    const env = serverEnv(process.env, { runAsNode: plan.runAsNode, path: dirs.join(path.delimiter), platform: process.platform });
    const invocation = spawnInvocation(plan.command, plan.args, process.platform);
    let proc;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: root && fs.existsSync(root) ? root : os.homedir(),
        env, shell: invocation.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, reason: `Couldn't start ${plan.name}: ${e.message}` });
      return;
    }
    const connection = newConnection(key, plan.serverId);
    connection.write = (buf) => { if (proc.stdin.writable) proc.stdin.write(buf); };
    connection.kill = (graceMs) => {
      try { proc.stdin.end(); } catch { /* already closed */ }
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (!graceMs) { proc.kill(); return; }
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, graceMs);
      proc.once('exit', () => clearTimeout(timer));
    };
    const reader = forwardFrom(connection);
    proc.stdout.on('data', (chunk) => reader.push(chunk));
    proc.stderr.on('data', (chunk) => logStderr(connection, chunk.toString('utf8')));
    proc.stdin.on('error', () => { /* the exit handler reports it */ });
    let spawned = false;
    proc.once('spawn', () => { spawned = true; servers.set(key, connection); resolve({ ok: true }); });
    proc.once('error', (e) => {
      if (spawned) reportExit(connection, null, null, e.message);
      else resolve({ ok: false, reason: `Couldn't start ${plan.name}: ${e.message}` });
    });
    proc.once('exit', (code, signal) => reportExit(connection, code, signal));
  });
}

function connectTcp(key, plan) {
  return new Promise((resolve) => {
    const unreachable = plan.unreachable || `${plan.name} is not listening on ${plan.host}:${plan.port}.`;
    const socket = net.connect({ host: plan.host, port: plan.port });
    const connection = newConnection(key, plan.serverId);
    let connected = false;
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, reason: unreachable }); }, TCP_CONNECT_TIMEOUT_MS);
    socket.on('error', () => {
      clearTimeout(timer);
      if (!connected) resolve({ ok: false, reason: unreachable });
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      connected = true;
      connection.write = (buf) => { if (!socket.destroyed) socket.write(buf); };
      connection.kill = () => socket.destroy();
      const reader = forwardFrom(connection);
      socket.on('data', (chunk) => reader.push(chunk));
      socket.once('close', () => reportExit(connection, null, null, 'The language server closed the connection.'));
      servers.set(key, connection);
      resolve({ ok: true });
    });
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function startServer(languageId, root) {
  const { plan, dirs } = await planLaunch(languageId, root);
  if (!plan.ok) return { ok: false, unknown: !!plan.unknown, serverId: plan.serverId, name: plan.name, reason: plan.reason };
  const key = serverKey(plan.serverId, root);
  if (servers.has(key)) return describe(key, plan, root, true);
  if (starting.has(key)) return starting.get(key);
  const started = (async () => {
    const result = plan.transport === 'tcp' ? await connectTcp(key, plan) : await spawnStdio(key, plan, root, dirs);
    if (!result.ok) return { ok: false, serverId: plan.serverId, name: plan.name, reason: result.reason };
    return describe(key, plan, root, false);
  })();
  starting.set(key, started);
  try { return await started; } finally { starting.delete(key); }
}

function describe(key, plan, root, reused) {
  const pythonPath = plan.serverId === 'pyright' ? findVenvPython(root, process.platform, fs.existsSync) : null;
  return {
    ok: true, key, reused,
    serverId: plan.serverId, name: plan.name, languages: plan.languages,
    settings: serverSettings(plan.serverId, { pythonPath }),
    ...(plan.initializationOptions ? { initializationOptions: plan.initializationOptions } : {}),
  };
}

// Unregisters at once (so a new ensure for the key starts a fresh server and no
// late exit is reported) and gives the process a moment to act on `exit`.
function stopServer(key, graceMs = STOP_GRACE_MS) {
  const connection = servers.get(key);
  if (!connection) return false;
  servers.delete(key);
  connection.kill(graceMs);
  return true;
}

// App quit: no time for a graceful shutdown handshake — just don't orphan them.
function stopAllLanguageServers() {
  for (const key of [...servers.keys()]) stopServer(key, 0);
}

ipcMain.handle('lsp-ensure', async (_e, { languageId, root } = {}) => {
  try {
    return await startServer(String(languageId || ''), root ? String(root) : null);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.on('lsp-send', (_e, { key, message } = {}) => {
  const connection = servers.get(key);
  if (connection && typeof message === 'string') connection.write(encodeMessage(message));
});

ipcMain.handle('lsp-stop', (_e, { key } = {}) => stopServer(key));
ipcMain.handle('lsp-stop-all', () => { stopAllLanguageServers(); return true; });

module.exports = { stopAllLanguageServers };
