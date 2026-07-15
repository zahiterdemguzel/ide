// Coordinator for the embedded Ollama engine — the "custom models" feature. It
// resolves the bundled `ollama` binary, runs a single `ollama serve` sidecar with
// its model store kept inside our app data dir (so an uninstall can remove it),
// lists/pulls/deletes models, probes the machine's RAM/VRAM, and registers the IPC
// the renderer (and, read-only, a paired phone) drives. All non-trivial decisions
// live in the pure libs (ollama-models-lib / ollama-fit-lib / ollama-bin-lib);
// this file is the OS/HTTP/spawn shell around them. The Anthropic->Ollama
// translation for actually running a session lives in ollama-proxy.js.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const bridge = require('./remote-bridge');
const { sendToRenderer } = require('./window');
const { sharedDataDir } = require('./instance');
const { cleanEnv } = require('./proc-env');
const proxy = require('./ollama-proxy');
const { binRelPath, pickPort } = require('./ollama-bin-lib');
const {
  CATALOG, catalogFilter, parsePullProgress, toOllamaId, ollamaName,
} = require('./ollama-models-lib');
const { modelFit, formatReq } = require('./ollama-fit-lib');

const OLLAMA_DIR = path.join(sharedDataDir, 'ollama');
const MODELS_DIR = path.join(OLLAMA_DIR, 'models');

// --- binary resolution -------------------------------------------------------
// The engine binary is bundled (electron-builder extraResources) under
// <resources>/ollama/<subdir>/ when packaged, or vendor/ollama/<subdir>/ in a dev
// run. If neither exists we fall back to a system `ollama` on PATH so a dev
// machine without the vendored binary still works.
let binPath = null;
function resolveOllamaBin() {
  if (binPath) return binPath;
  const { subdir, exe } = binRelPath(process.platform, process.arch);
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'ollama')]
    : [path.join(__dirname, '..', '..', 'vendor', 'ollama')];
  for (const root of roots) {
    const p = path.join(root, subdir, exe);
    if (fs.existsSync(p)) {
      if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch { /* best effort */ } }
      binPath = p;
      return binPath;
    }
  }
  binPath = systemOllama(); // may be null
  return binPath;
}
function systemOllama() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { execFileSync } = require('child_process');
    const out = execFileSync(finder, ['ollama'], { encoding: 'utf8' });
    const found = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return found || null;
  } catch { return null; }
}

// --- serve lifecycle ---------------------------------------------------------
let serveProc = null;
let serveBase = '';
let servePromise = null;

function getServeBase() { return serveBase; }
function isServeRunning() { return !!serveProc && !!serveBase; }

// Start `ollama serve` once, storing models under our app data dir. Resolves to
// the base URL after a health check; memoized so concurrent callers share it.
function ensureServe() {
  if (serveBase) return Promise.resolve(serveBase);
  if (servePromise) return servePromise;
  servePromise = (async () => {
    const bin = resolveOllamaBin();
    if (!bin) throw new Error('Ollama engine binary not found');
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const port = pickPort(11434, []);
    const host = `127.0.0.1:${port || 11434}`;
    const env = cleanEnv({ ...process.env, OLLAMA_MODELS: MODELS_DIR, OLLAMA_HOST: host });
    serveProc = spawn(bin, ['serve'], {
      env,
      // detached on POSIX gives us a process group to kill (serve spawns model
      // runners); on Windows we kill the tree with taskkill /T instead.
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    serveProc.on('exit', () => { if (serveProc) { serveProc = null; serveBase = ''; servePromise = null; } });
    serveProc.on('error', () => { serveProc = null; serveBase = ''; servePromise = null; });
    const base = `http://${host}`;
    await waitForHealth(base, 20000);
    serveBase = base;
    return serveBase;
  })();
  servePromise.catch(() => { servePromise = null; });
  return servePromise;
}

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await ollamaGet(base, '/api/version', 1500); return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Ollama engine did not start in time');
    await delay(300);
  }
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Start both the engine and the translation proxy; returns the proxy port so a
// session spawn can route the CLI through ANTHROPIC_BASE_URL. Called from
// sessions.js when a session picks an `ollama:` model, and from `ollama-ensure`.
async function ensureRuntime() {
  await ensureServe();
  const proxyPort = await proxy.startProxyServer();
  return { serveBase, proxyPort };
}

// Kill the engine and its model-runner children so nothing leaks on quit.
function stopOllama() {
  const p = serveProc;
  serveProc = null;
  serveBase = '';
  servePromise = null;
  if (!p || !p.pid) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => {});
    } else {
      // Negative pid = the whole process group (serve + runners).
      try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); }
    }
  } catch { /* already gone */ }
}

// --- talking to the engine ---------------------------------------------------
function ollamaGet(base, pathname, timeoutMs) {
  return ollamaRequest(base, 'GET', pathname, null, timeoutMs);
}
function ollamaRequest(base, method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base);
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { out += c; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`ollama ${method} ${pathname} -> ${res.statusCode}: ${out.slice(0, 200)}`));
          if (!out) return resolve({});
          try { resolve(JSON.parse(out)); } catch { resolve({}); }
        });
      },
    );
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('ollama request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

// List installed models WITHOUT starting the engine. Booting `ollama serve` just
// to populate the model dropdowns is what made opening Settings (and every app
// launch) block for seconds; the engine is started lazily — only when the user
// sets up Custom Models or actually runs an `ollama:` session. When serve isn't
// running yet we have nothing to list, so return empty.
async function listInstalled() {
  if (!isServeRunning()) return [];
  const res = await ollamaGet(serveBase, '/api/tags', 5000);
  const models = Array.isArray(res.models) ? res.models : [];
  return models.map((m) => ({ name: m.name, size: typeof m.size === 'number' ? m.size : null }));
}

// --- pulls (with a cancel handle) --------------------------------------------
const activePulls = new Map(); // name -> http.ClientRequest

function pull(name, onProgress) {
  return new Promise((resolve, reject) => {
    ensureServe().then((base) => {
      const u = new URL('/api/pull', base);
      const data = JSON.stringify({ name, stream: true });
      const req = http.request(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
        (res) => {
          let buf = '';
          let failed = null;
          res.setEncoding('utf8');
          const drain = (line) => {
            const prog = parsePullProgress(line);
            if (!prog) return;
            if (prog.error) failed = prog.error;
            if (onProgress) onProgress(prog);
          };
          res.on('data', (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) { drain(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
          });
          res.on('end', () => {
            drain(buf);
            activePulls.delete(name);
            if (failed) reject(new Error(failed)); else resolve();
          });
          res.on('error', (err) => { activePulls.delete(name); reject(err); });
        },
      );
      req.on('error', (err) => { activePulls.delete(name); reject(err); });
      activePulls.set(name, req);
      req.write(data);
      req.end();
    }).catch(reject);
  });
}

function cancelPull(name) {
  const req = activePulls.get(name);
  if (req) { try { req.destroy(new Error('cancelled')); } catch { /* already gone */ } activePulls.delete(name); }
}

async function remove(name) {
  const base = await ensureServe();
  await ollamaRequest(base, 'DELETE', '/api/delete', { name }, 10000);
}

// Stop the engine and delete the whole model store. The macOS "uninstall" path
// (no OS uninstaller hook there) and a general reset.
async function removeAll() {
  stopOllama();
  await delay(200);
  try { fs.rmSync(OLLAMA_DIR, { recursive: true, force: true }); } catch { /* may be locked briefly */ }
}

// --- system detection (RAM / VRAM) -------------------------------------------
let systemInfo = null;
async function detectSystem() {
  if (systemInfo) return systemInfo;
  const ramGB = Math.round(os.totalmem() / 1e9);
  let vramGB = null;
  let unified = false;
  try {
    if (process.platform === 'win32') {
      const out = await run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Measure-Object -Property AdapterRAM -Maximum).Maximum']);
      const bytes = Number(String(out).trim());
      if (Number.isFinite(bytes) && bytes > 0) vramGB = Math.round(bytes / 1e9);
    } else if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        unified = true; // Apple Silicon: unified memory, VRAM == system RAM
      } else {
        const out = await run('system_profiler', ['SPDisplaysDataType']);
        const m = /VRAM.*?:\s*([\d.]+)\s*(GB|MB)/i.exec(String(out));
        if (m) vramGB = Math.round(m[2].toUpperCase() === 'GB' ? Number(m[1]) : Number(m[1]) / 1024);
      }
    }
  } catch { /* best effort — leave vramGB null (fit falls back to RAM-only) */ }
  systemInfo = { ramGB, vramGB, unified };
  return systemInfo;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 8000, env: cleanEnv() }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// Attach the catalog model's known requirement + a fit level for this machine.
function annotate(entry, sys) {
  const req = formatReq(entry);
  const fit = modelFit(entry, sys);
  return { ...entry, req, fit };
}
// An installed model's requirement comes from the catalog when we know it (match
// on the exact name), else it's unknown (a free-typed pull).
function reqForInstalled(name, sys) {
  const cat = CATALOG.find((m) => m.name === name);
  return cat ? annotate(cat, sys) : { name, req: '', fit: modelFit({}, sys) };
}

// --- IPC ---------------------------------------------------------------------
function report(context, err) {
  const message = err && err.stack ? err.stack : String(err);
  console.error('[ollama]', context, message);
  return { error: err && err.message ? err.message : String(err) };
}

bridge.handle('ollama-status', async () => {
  const system = await detectSystem();
  let version = '';
  if (serveBase) { try { version = (await ollamaGet(serveBase, '/api/version', 1500)).version || ''; } catch { /* stale */ } }
  return { serveRunning: isServeRunning(), version, system, hasBinary: !!resolveOllamaBin() };
});

bridge.handle('ollama-ensure', async () => {
  try {
    await ensureRuntime();
    const system = await detectSystem();
    let version = '';
    try { version = (await ollamaGet(serveBase, '/api/version', 1500)).version || ''; } catch { /* ignore */ }
    return { serveRunning: isServeRunning(), version, system, hasBinary: !!resolveOllamaBin() };
  } catch (err) { return report('starting the engine', err); }
});

bridge.handle('ollama-catalog', async (_e, query) => {
  try {
    const sys = await detectSystem();
    return catalogFilter(CATALOG, query).map((m) => annotate(m, sys));
  } catch (err) { return report('listing the catalog', err); }
});

// Installed models as ready-to-merge dropdown rows (id already namespaced), each
// with its size and fit. The renderer appends these to the static Claude MODELS.
bridge.handle('ollama-list', async () => {
  try {
    const sys = await detectSystem();
    const installed = await listInstalled();
    return installed.map((m) => {
      const info = reqForInstalled(m.name, sys);
      return { id: toOllamaId(m.name), name: m.name, size: m.size, req: info.req, fit: info.fit };
    });
  } catch (err) {
    // Engine not set up yet is normal — return an empty list, not an error dialog.
    console.error('[ollama] ollama-list', err && err.message);
    return [];
  }
});

bridge.handle('ollama-pull', async (_e, name) => {
  const model = typeof name === 'string' ? name.trim() : '';
  if (!model) return { error: 'no model name' };
  try {
    await pull(model, (prog) => sendToRenderer('ollama-pull-progress', { name: model, ...prog }));
    sendToRenderer('ollama-models-changed', {});
    return { ok: true };
  } catch (err) { return report(`pulling ${model}`, err); }
});

bridge.on('ollama-cancel-pull', (_e, name) => {
  try { cancelPull(typeof name === 'string' ? name.trim() : ''); } catch (err) { report('cancelling pull', err); }
});

bridge.handle('ollama-remove', async (_e, name) => {
  const model = typeof name === 'string' ? name.trim() : '';
  if (!model) return { error: 'no model name' };
  try {
    await remove(model);
    sendToRenderer('ollama-models-changed', {});
    return { ok: true };
  } catch (err) { return report(`removing ${model}`, err); }
});

bridge.handle('ollama-remove-all', async () => {
  try { await removeAll(); sendToRenderer('ollama-models-changed', {}); return { ok: true }; }
  catch (err) { return report('removing all models', err); }
});

module.exports = {
  ensureServe,
  ensureRuntime,
  getServeBase,
  isServeRunning,
  stopOllama,
  ollamaName,
};
