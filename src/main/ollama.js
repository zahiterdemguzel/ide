// Coordinator for the local-model "custom models" feature. Historically this ran a
// bundled `ollama serve` sidecar; it now delegates to an in-process node-llama-cpp
// engine (src/main/llama-engine.js) that loads GGUF files directly — no external
// binary to download at install/build time and no child process to manage. The IPC
// surface, the `ollama-*` channel names, and the `ollama:` model-id namespace are
// kept as-is so the renderer, the phone bridge, and saved sessions don't change.
// The Anthropic->model translation for actually running a session lives in
// ollama-proxy.js; all pure decisions live in the ollama-*-lib.js modules.

const bridge = require('./remote-bridge');
const { sendToRenderer } = require('./window');
const proxy = require('./ollama-proxy');
const engine = require('./llama-engine');
const {
  CATALOG, catalogFilter, toOllamaId, ollamaName, resolvePullTarget,
} = require('./ollama-models-lib');
const { modelFit, formatReq } = require('./ollama-fit-lib');

// --- runtime lifecycle -------------------------------------------------------
// There's no serve process anymore; "runtime" is just the translation proxy plus
// the lazily-loaded engine. Kept as ensureRuntime()/stopOllama() so sessions.js
// and index.js don't have to change.
async function ensureRuntime() {
  const proxyPort = await proxy.startProxyServer();
  return { proxyPort };
}

function stopOllama() {
  engine.stop().catch(() => {});
}

// --- system detection (RAM / VRAM), memoized --------------------------------
let systemInfo = null;
async function detectSystem() {
  if (systemInfo) return systemInfo;
  systemInfo = await engine.detectSystem();
  return systemInfo;
}

// --- fit annotation ----------------------------------------------------------
function annotate(entry, sys) {
  return { ...entry, req: formatReq(entry), fit: modelFit(entry, sys) };
}
// An installed model's requirement comes from the catalog when we know it (exact
// name match), else it's unknown (a free-typed URI pull).
function reqForInstalled(name, sys) {
  const cat = CATALOG.find((m) => m.name === name);
  return cat ? annotate(cat, sys) : { name, req: '', fit: modelFit({}, sys) };
}

// --- IPC ---------------------------------------------------------------------
function report(context, err) {
  const message = err && err.stack ? err.stack : String(err);
  console.error('[custom-models]', context, message);
  return { error: err && err.message ? err.message : String(err) };
}

bridge.handle('ollama-status', async () => {
  const system = await detectSystem();
  return { serveRunning: true, version: 'node-llama-cpp', system, hasBinary: true };
});

bridge.handle('ollama-ensure', async () => {
  try {
    await ensureRuntime();
    const system = await detectSystem();
    return { serveRunning: true, version: 'node-llama-cpp', system, hasBinary: true };
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
    const installed = await engine.listInstalled();
    return installed.map((m) => {
      const info = reqForInstalled(m.name, sys);
      return { id: toOllamaId(m.name), name: m.name, size: m.size, req: info.req, fit: info.fit };
    });
  } catch (err) {
    // Nothing installed / engine not warmed up yet is normal — empty list, not an error.
    console.error('[custom-models] ollama-list', err && err.message);
    return [];
  }
});

bridge.handle('ollama-pull', async (_e, name) => {
  const target = resolvePullTarget(name);
  if (!target) return { error: 'unknown model — pick one from the list or paste a GGUF URL' };
  try {
    await engine.pull(target.source, target.name, (prog) => {
      if (prog) sendToRenderer('ollama-pull-progress', { name: target.name, ...prog });
    });
    sendToRenderer('ollama-models-changed', {});
    return { ok: true };
  } catch (err) { return report(`pulling ${target.name}`, err); }
});

bridge.on('ollama-cancel-pull', (_e, name) => {
  const target = resolvePullTarget(name);
  try { engine.cancelPull(target ? target.name : String(name || '').trim()); } catch (err) { report('cancelling pull', err); }
});

bridge.handle('ollama-remove', async (_e, name) => {
  const model = typeof name === 'string' ? name.trim() : '';
  if (!model) return { error: 'no model name' };
  try {
    await engine.remove(model);
    sendToRenderer('ollama-models-changed', {});
    return { ok: true };
  } catch (err) { return report(`removing ${model}`, err); }
});

bridge.handle('ollama-remove-all', async () => {
  try { await engine.removeAll(); sendToRenderer('ollama-models-changed', {}); return { ok: true }; }
  catch (err) { return report('removing all models', err); }
});

module.exports = {
  ensureRuntime,
  stopOllama,
  ollamaName,
};
