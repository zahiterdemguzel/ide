const path = require('path');

// --- Debugger (Debug Adapter Protocol) — the Electron-free half ---
// The IDE drives real debug adapters over DAP, the protocol VS Code speaks to
// every debugger. This module holds everything that doesn't touch a process,
// socket or window: wire framing, launch.json → adapter-argument translation,
// interpreter choice, and the small conversions the UI needs. debug.js owns the
// processes/IPC; dap-client.js owns the request/response bookkeeping.

// ── Wire framing ────────────────────────────────────────────────────────────
// A DAP message is `Content-Length: <bytes>\r\n\r\n<json>`, the same framing as
// LSP. Length is in BYTES, so a non-ASCII payload must be measured as UTF-8.
function encodeDapMessage(msg) {
  const json = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

// Incremental parser for a byte stream that may split or batch messages at any
// boundary. Feed it chunks; it calls onMessage once per complete message.
function createDapReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = buffer.slice(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) { buffer = buffer.slice(headerEnd + 4); continue; } // junk header: skip it
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (buffer.length < bodyEnd) return; // wait for the rest of the body
        const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
        buffer = buffer.slice(bodyEnd);
        try { onMessage(JSON.parse(body)); } catch { /* malformed body: drop it */ }
      }
    },
  };
}

// ── Which configs we can debug ──────────────────────────────────────────────
// launch.json `type` → the adapter that debugs it. Only debugpy so far; adding an
// adapter means a row here plus its spawn recipe in debug.js.
const ADAPTER_FOR_TYPE = { debugpy: 'debugpy', python: 'debugpy' };

function adapterFor(cfg) {
  return (cfg && ADAPTER_FOR_TYPE[String(cfg.type || '').toLowerCase()]) || null;
}

// launch.json keys that only mean something to VS Code itself (task wiring,
// UI placement, per-OS overrides) — never part of what the adapter receives.
const CLIENT_ONLY_KEYS = [
  'preLaunchTask', 'postDebugTask', 'presentation', 'internalConsoleOptions',
  'serverReadyAction', 'windows', 'osx', 'linux', 'debugServer', 'envFile',
];

// Substitute ${…} variables in every string of a nested value (adapter args can
// nest: `connect.host`, `pathMappings[].localRoot`, …).
function substDeep(value, substVars) {
  if (typeof value === 'string') return substVars(value);
  if (Array.isArray(value)) return value.map((v) => substDeep(v, substVars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substDeep(v, substVars);
    return out;
  }
  return value;
}

// Every unresolved `${prefix:id}` anywhere in a nested value — the debug twin of
// the run path's findInputIds/findCommandIds, which only scan flat run specs.
function findPlaceholders(value, prefix) {
  const re = new RegExp(`\\$\\{${prefix}:([^}]+)\\}`, 'g');
  const ids = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(re)) ids.add(m[1]); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...ids];
}

// Turn a launch.json config into the arguments of the adapter's `launch` /
// `attach` request, as VS Code does before handing it over: per-OS block merged,
// variables resolved, envFile folded under the inline env, client-only keys
// dropped. `lib` is a makeRunConfigLib instance (substVars/mergePlatform).
function adapterArguments(cfg, lib, envFileVars = {}) {
  const merged = lib.mergePlatform(cfg);
  const args = {};
  for (const [k, v] of Object.entries(merged)) {
    if (!CLIENT_ONLY_KEYS.includes(k)) args[k] = v;
  }
  const resolved = substDeep(args, lib.substVars);
  resolved.request = resolved.request === 'attach' ? 'attach' : 'launch';
  if (resolved.request === 'launch') {
    const env = { ...envFileVars };
    for (const [k, v] of Object.entries(resolved.env || {})) env[k] = v == null ? v : String(v);
    if (Object.keys(env).length) resolved.env = env;
    // VS Code's debugpy default: run the program in a terminal so it gets a real
    // stdin (input() works). We open that terminal as an in-app tab.
    if (!resolved.console) resolved.console = 'integratedTerminal';
    if (!resolved.cwd) resolved.cwd = lib.substVars('${workspaceFolder}');
  }
  return resolved;
}

// The ad-hoc config behind the editor's "Debug this file" (VS Code's "Debug
// Python File"): launch the file from the repo root, in a terminal, optionally
// on the interpreter the user registered for Python.
function fileDebugTarget(absFile, repoPath, python) {
  const args = {
    name: `Debug ${path.basename(absFile)}`, type: 'debugpy', request: 'launch',
    program: absFile, cwd: repoPath, console: 'integratedTerminal', justMyCode: true,
  };
  if (python) args.python = [python];
  return { name: args.name, adapter: 'debugpy', args, preRuns: [], postRuns: [] };
}

// An attach config naming a host/port connects straight to a running debugpy
// server (`debugpy.listen(...)` / `python -m debugpy --listen`) — that server is
// itself the adapter, so no adapter process is spawned. Returns null for every
// other shape (launch, attach by processId, reverse `listen` attach), which go
// through a spawned adapter instead.
function attachSocketTarget(args) {
  if (!args || args.request !== 'attach' || args.processId != null || args.listen) return null;
  const connect = args.connect || {};
  const port = Number(connect.port != null ? connect.port : args.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: connect.host || args.host || '127.0.0.1', port };
}

// The interpreter that runs debugpy's adapter (and, for a launch, the program):
// the config's own `python` (a path or an argv array) / legacy `pythonPath`,
// else the project's .venv when one exists, else python on PATH. `exists` is
// injected so this stays pure.
function pythonCommand(args, repoPath, platform, exists) {
  const own = args && (args.python || args.pythonPath);
  if (Array.isArray(own) && own.length) return own.map(String);
  if (typeof own === 'string' && own) return [own];
  const venvPython = platform === 'win32'
    ? path.join(repoPath || '', '.venv', 'Scripts', 'python.exe')
    : path.join(repoPath || '', '.venv', 'bin', 'python');
  if (repoPath && exists(venvPython)) return [venvPython];
  return [platform === 'win32' ? 'python' : 'python3'];
}

// The VS Code debugpy extension ships its own copy of debugpy under
// `<ext>/bundled/libs`. Given the extension folder names, pick the newest so a
// project without `pip install debugpy` can still be debugged.
function newestBundledDebugpy(extensionsDir, folderNames) {
  const matches = (folderNames || [])
    .filter((n) => /^ms-python\.debugpy-\d/.test(n))
    .sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
  return matches.length ? path.join(extensionsDir, matches[0], 'bundled', 'libs') : null;
}
const versionOf = (folder) => (/-(\d+(?:\.\d+)*)/.exec(folder) || [])[1] || '0';
function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ── runInTerminal ───────────────────────────────────────────────────────────
// debugpy asks the client to start the debuggee in a terminal (`runInTerminal`)
// with an argv array. Our terminals are interactive shells we type a line into,
// so the argv must be quoted for that shell: POSIX single quotes, or PowerShell
// single quotes plus the `&` call operator (a quoted first word is a string,
// not a command, without it).
function shellCommandLine(argv, platform) {
  if (platform === 'win32') {
    const quoted = argv.map((a) => (/^[\w./:\\=-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "''")}'`));
    return (quoted[0] && quoted[0].startsWith("'") ? '& ' : '') + quoted.join(' ');
  }
  return argv.map((a) => (/^[\w./:=@%+,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

// runInTerminal's env maps a name to null to mean "unset it". Our terminal spawn
// takes plain additions, so null entries are dropped (best effort).
function terminalEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (v != null) out[k] = String(v);
  return out;
}

// ── Breakpoints & frames ────────────────────────────────────────────────────
// The UI stores a breakpoint as { line, condition?, hitCondition?, logMessage? };
// DAP's SourceBreakpoint has the same shape minus empty fields.
function sourceBreakpoints(list) {
  return (list || []).map((bp) => {
    const out = { line: bp.line };
    if (bp.condition) out.condition = bp.condition;
    if (bp.hitCondition) out.hitCondition = bp.hitCondition;
    if (bp.logMessage) out.logMessage = bp.logMessage;
    return out;
  });
}

// The exception filters an adapter enables by default (capabilities from its
// `initialize` response) — debugpy's "Uncaught Exceptions", for instance.
function defaultExceptionFilters(capabilities) {
  return ((capabilities && capabilities.exceptionBreakpointFilters) || [])
    .filter((f) => f.default).map((f) => f.filter);
}

// A frame's source path, repo-relative with forward slashes (what the editor
// opens), or null when the file lives outside the open folder (stdlib, site-packages).
function repoRelative(repoPath, absPath) {
  if (!repoPath || !absPath) return null;
  const rel = path.relative(repoPath, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Requests the renderer may send through the generic `debug-request` channel:
// the inspection/stepping set. Lifecycle requests (launch/attach/disconnect,
// setBreakpoints) go through their own handlers so main keeps them consistent.
const PASSTHROUGH_REQUESTS = new Set([
  'threads', 'stackTrace', 'scopes', 'variables', 'evaluate', 'setVariable',
  'continue', 'next', 'stepIn', 'stepOut', 'pause', 'exceptionInfo', 'source',
]);

module.exports = {
  encodeDapMessage, createDapReader, adapterFor, substDeep, findPlaceholders,
  adapterArguments, fileDebugTarget, attachSocketTarget, pythonCommand, newestBundledDebugpy,
  shellCommandLine, terminalEnv, sourceBreakpoints, defaultExceptionFilters,
  repoRelative, PASSTHROUGH_REQUESTS,
};
