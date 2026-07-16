// In-process local-model engine backing the "custom models" feature. Replaces the
// old embedded `ollama serve` sidecar: instead of shelling out to a bundled binary
// and forwarding HTTP, it runs GGUF models directly with node-llama-cpp (which
// ships its own prebuilt llama.cpp binaries through npm). node-llama-cpp is ESM +
// main-process only, so it's loaded lazily via dynamic import() from this CommonJS
// module and cached.
//
// To keep the rest of the feature untouched, chat() speaks the SAME Ollama
// /api/chat *shape* the pure translate lib (ollama-translate-lib.js) already
// consumes: it streams `{ message: { content, tool_calls }, done, ... }` chunk
// objects. The proxy pipes those straight through the unchanged translation, so
// the Anthropic CLI can't tell the difference.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sharedDataDir } = require('./instance');
const { parsePullProgress } = require('./ollama-models-lib');
const {
  buildHistory, buildFunctions, buildGenOptions, toToolCalls, doneReason,
  looksLikeToolCallStart, salvageToolCall,
} = require('./llama-engine-lib');

const LLAMA_DIR = path.join(sharedDataDir, 'llama');
const MODELS_DIR = path.join(LLAMA_DIR, 'models');

function getModelsDir() { return MODELS_DIR; }
function modelPathFor(name) { return path.join(MODELS_DIR, `${name}.gguf`); }

// --- lazy node-llama-cpp handle ----------------------------------------------
let nlcPromise = null;
function nlc() {
  if (!nlcPromise) nlcPromise = import('node-llama-cpp');
  return nlcPromise;
}
let llamaPromise = null;
async function getLlamaInstance() {
  if (!llamaPromise) {
    llamaPromise = nlc().then(({ getLlama }) => getLlama());
    llamaPromise.catch(() => { llamaPromise = null; });
  }
  return llamaPromise;
}

// --- loaded-model cache (LRU of 1) -------------------------------------------
// Loading a GGUF into memory is the expensive step, so we keep at most one model
// resident and reuse it across requests; asking for a different model evicts the
// current one first. The context is sized *to the actual prompt* (see ensureContext)
// because Claude Code's prompt — system prompt + every tool/MCP schema — varies
// enormously (10k to 40k+ tokens) between setups; a fixed size either wastes memory
// or is too small and the CLI's context-shift fails with "context shift strategy did
// not return a history that fits" (surfaced as an empty/502 reply).
let loaded = null; // { name, model, chat, context, contextSize, cpu }

const CTX_MIN = 8192; // floor for small prompts
const CTX_MAX = 65536; // hard cap — beyond this local models degrade and KV memory explodes
const CTX_RESERVE = 3072; // headroom for the model's own reply + chat-format overhead

async function loadModel(name) {
  if (loaded && loaded.name === name) return loaded;
  await unload();
  const file = modelPathFor(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Local model "${name}" is not installed. Open Settings → Custom models to download it.`);
  }
  const llama = await getLlamaInstance();
  const model = await llama.loadModel({ modelPath: file });
  loaded = { name, model, chat: null, context: null, contextSize: 0, cpu: false };
  return loaded;
}

// Rough token count of the whole incoming prompt (system + messages + tool schemas)
// via the model's own tokenizer, so we can size the context to fit it.
function estimatePromptTokens(model, ollamaBody) {
  let text = '';
  for (const m of ollamaBody.messages || []) text += `${m && m.content ? m.content : ''}\n`;
  if (Array.isArray(ollamaBody.tools) && ollamaBody.tools.length) text += JSON.stringify(ollamaBody.tools);
  try { return model.tokenize(text).length; } catch { return Math.ceil(text.length / 3.5); }
}

function desiredContextSize(promptTokens, trainCtx) {
  const needed = promptTokens + CTX_RESERVE;
  let want = Math.ceil(needed * 1.15);
  // Prefer not to exceed the model's native train context (going past it degrades
  // quality) — only do so when the prompt genuinely doesn't fit within it.
  const cap = trainCtx || CTX_MAX;
  if (needed <= cap) want = Math.min(want, cap);
  want = Math.max(CTX_MIN, Math.min(CTX_MAX, want));
  return Math.ceil(want / 2048) * 2048; // round up to a tidy multiple
}

// Ensure the loaded model has a context of at least `size` tokens, (re)creating it
// when the current one is too small. Tries the GPU first (flashAttention shrinks the
// KV cache so a big context fits more often); if it won't fit, reloads the model on
// CPU/system RAM, where a large context always fits — slower, but it actually works.
async function ensureContext(size) {
  if (loaded.context && loaded.contextSize >= size) return loaded.chat;
  const { LlamaChat } = await nlc();
  const llama = await getLlamaInstance();
  if (loaded.context) { try { loaded.context.dispose(); } catch { /* best effort */ } loaded.context = null; loaded.chat = null; }

  let context = null;
  if (!loaded.cpu) {
    try { context = await loaded.model.createContext({ contextSize: size, flashAttention: true }); }
    catch (err) { console.error('[custom-models] GPU context', size, 'did not fit:', err && err.message); }
  }
  if (!context) {
    if (!loaded.cpu) {
      console.error('[custom-models] falling back to CPU for', loaded.name, '(GPU could not hold a', size, 'context)');
      try { await loaded.model.dispose(); } catch { /* best effort */ }
      loaded.model = await llama.loadModel({ modelPath: modelPathFor(loaded.name), gpuLayers: 0 });
      loaded.cpu = true;
    }
    context = await loaded.model.createContext({ contextSize: size });
  }
  loaded.context = context;
  loaded.contextSize = context.contextSize;
  loaded.chat = new LlamaChat({ contextSequence: context.getSequence() });
  console.error('[custom-models]', loaded.name, 'context ready:', loaded.contextSize, loaded.cpu ? '(CPU)' : '(GPU)');
  return loaded.chat;
}

async function unload() {
  const cur = loaded;
  loaded = null;
  if (!cur) return;
  try { if (cur.context) cur.context.dispose(); } catch { /* best effort */ }
  try { await cur.model.dispose(); } catch { /* best effort */ }
}

// A single context sequence can't run two generations at once; serialize them.
let genChain = Promise.resolve();
function withGenLock(fn) {
  const run = genChain.then(fn, fn);
  genChain = run.then(() => {}, () => {});
  return run;
}

// --- one stateless generation turn -------------------------------------------
// Runs a single model turn from the full history and streams Ollama-shaped chunks
// to onChunk. Stops as soon as the model emits function call(s) (the CLI executes
// them and re-sends the history next request). Returns the assembled full Ollama
// response so the non-streaming path can build a one-shot Anthropic message.
async function chat(ollamaBody = {}, { onChunk, signal } = {}) {
  const name = String(ollamaBody.model || '');
  return withGenLock(async () => {
    const { model } = await loadModel(name);
    const promptTokens = estimatePromptTokens(model, ollamaBody);
    console.error('[custom-models]', name, 'incoming prompt ~', promptTokens, 'tokens');
    if (promptTokens + CTX_RESERVE > CTX_MAX) {
      throw new Error(`This session's prompt is ~${promptTokens} tokens, larger than the local model limit (${CTX_MAX}). Disable some MCP servers/tools for this session or use a smaller system prompt — local models can't hold a prompt this big.`);
    }
    const llamaChat = await ensureContext(desiredContextSize(promptTokens, model.trainContextSize));
    const history = buildHistory(ollamaBody.messages);
    const functions = buildFunctions(ollamaBody.tools);
    const toolNames = functions ? Object.keys(functions) : [];
    const emit = (chunk) => { if (onChunk) onChunk(chunk); };

    // Small models often print a tool call as JSON text instead of emitting native
    // tool-call tokens. So when tools are offered and the reply *starts* like one, we
    // withhold streaming it as text ('hold'); if it salvages to a real call we convert
    // it (and never show the raw JSON), otherwise we flush it as normal text. Replies
    // that don't look like a call stream through immediately as before.
    let text = '';
    let streamedLen = 0;
    let mode = null; // null=undecided, 'stream' | 'hold'
    const flushPending = () => {
      const pending = text.slice(streamedLen);
      if (!pending) return;
      streamedLen = text.length;
      emit({ model: name, message: { role: 'assistant', content: pending }, done: false });
    };

    const res = await llamaChat.generateResponse(history, {
      ...buildGenOptions(ollamaBody.options),
      functions,
      signal,
      stopOnAbortSignal: true,
      onTextChunk(piece) {
        if (!piece) return;
        text += piece;
        if (mode === null) {
          if (!text.trim()) return; // wait for the first non-whitespace char to decide
          mode = (toolNames.length && looksLikeToolCallStart(text)) ? 'hold' : 'stream';
        }
        if (mode === 'stream') flushPending();
      },
    });

    let toolCalls = toToolCalls(res.functionCalls);
    let salvaged = false;
    if (!toolCalls.length && toolNames.length) {
      const s = salvageToolCall(text, toolNames);
      if (s) { toolCalls = s; salvaged = true; }
    }
    // Suppress the reply text only when we HELD it as a pure tool call (never streamed
    // it). If the call was buried in prose we already streamed, keep the prose and just
    // append the tool_use.
    const suppressText = salvaged && mode === 'hold';
    if (!suppressText) flushPending();

    const reason = doneReason(res.metadata && res.metadata.stopReason);
    emit({ model: name, message: { role: 'assistant', content: '', tool_calls: toolCalls.length ? toolCalls : undefined }, done: true, done_reason: reason, prompt_eval_count: 0, eval_count: 0 });

    return { model: name, message: { role: 'assistant', content: suppressText ? '' : text, tool_calls: toolCalls }, done: true, done_reason: reason, prompt_eval_count: 0, eval_count: 0 };
  });
}

// --- model management --------------------------------------------------------
async function listInstalled() {
  let files = [];
  try { files = fs.readdirSync(MODELS_DIR); } catch { return []; }
  return files
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => {
      const name = f.replace(/\.gguf$/i, '');
      let size = null;
      try { size = fs.statSync(path.join(MODELS_DIR, f)).size; } catch { /* ignore */ }
      return { name, size };
    });
}

const activeDownloads = new Map(); // name -> downloader

// Download a GGUF for `name` from the node-llama-cpp `source` URI, reporting the
// same { phase, pct, done, error } progress shape the renderer already handles
// (via parsePullProgress). Cancelable through cancelPull(name).
async function pull(source, name, onProgress) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const { createModelDownloader } = await nlc();
  const report = (status) => { if (onProgress) onProgress(parsePullProgress(status)); };
  const downloader = await createModelDownloader({
    modelUri: source,
    dirPath: MODELS_DIR,
    fileName: `${name}.gguf`,
    deleteTempFileOnCancel: true,
    onProgress({ totalSize, downloadedSize }) {
      report({ status: 'downloading', total: totalSize, completed: downloadedSize });
    },
  });
  activeDownloads.set(name, downloader);
  try {
    await downloader.download();
    report({ status: 'success' });
  } finally {
    activeDownloads.delete(name);
  }
}

function cancelPull(name) {
  const d = activeDownloads.get(name);
  if (d) { try { d.cancel(); } catch { /* already gone */ } activeDownloads.delete(name); }
}

async function remove(name) {
  if (loaded && loaded.name === name) await unload();
  const file = modelPathFor(name);
  try { fs.rmSync(file, { force: true }); } catch { /* may be locked briefly */ }
}

async function removeAll() {
  await unload();
  try { fs.rmSync(LLAMA_DIR, { recursive: true, force: true }); } catch { /* may be locked briefly */ }
}

// Tear down on quit so nothing keeps the GPU/model memory or a partial download.
async function stop() {
  for (const [, d] of activeDownloads) { try { d.cancel(); } catch { /* ignore */ } }
  activeDownloads.clear();
  await unload();
}

// Rough machine memory probe reused by the fit warning. VRAM comes from
// node-llama-cpp's device info; unified-memory machines (Apple Silicon) report
// their shared memory as VRAM.
async function detectSystem() {
  const ramGB = Math.round(os.totalmem() / 1e9);
  let vramGB = null;
  let unified = false;
  try {
    const llama = await getLlamaInstance();
    const info = await llama.getVramState();
    if (info && typeof info.total === 'number' && info.total > 0) vramGB = Math.round(info.total / 1e9);
    // node-llama-cpp reports a non-zero unifiedSize on shared-memory machines
    // (e.g. Apple Silicon), where VRAM budget is really system RAM.
    if (info && typeof info.unifiedSize === 'number' && info.unifiedSize > 0) unified = true;
  } catch { /* best effort — leave vramGB null (fit falls back to RAM-only) */ }
  return { ramGB, vramGB, unified };
}

module.exports = {
  chat,
  listInstalled,
  pull,
  cancelPull,
  remove,
  removeAll,
  stop,
  detectSystem,
  getModelsDir,
};
