// Editor AI assist: ghost-text completions and Cmd/Ctrl+K inline edits, served
// straight from the Messages API with the Claude Code OAuth token (see
// claude.js callMessages). Prompts, cleaners and the model policy are pure and
// live in ai-assist-lib.js; this module owns the network calls, cancellation and
// the IPC surface. The core functions (completeCode / editCode) take no Electron
// dependency so they can be driven from plain node; `electron` is only required
// when the IPC handlers register (see registerIpc at the bottom).

const { callMessages, runCli, readOauthToken, CC_IDENTITY } = require('./claude');
const lib = require('./ai-assist-lib');

// readOauthToken shells out to the macOS Keychain synchronously — far too slow
// to run per keystroke — so keep the token for a while and re-read on a 401.
const TOKEN_TTL_MS = 2 * 60 * 1000;
let cachedToken = null;
let cachedTokenAt = 0;
function currentToken() {
  if (!cachedToken || Date.now() - cachedTokenAt > TOKEN_TTL_MS) {
    cachedToken = readOauthToken();
    cachedTokenAt = Date.now();
  }
  return cachedToken;
}
function dropCachedToken() { cachedToken = null; cachedTokenAt = 0; }

// The first model id the API accepted per role (null = not yet probed).
const workingModel = { complete: null, edit: null };

// Try the role's models best-first until one is accepted. A model the API
// rejects (unknown id / unsupported field) falls through to the next; any other
// failure (auth, rate limit, abort, network) is returned as-is.
async function callWithModelFallback(role, request) {
  const remembered = workingModel[role];
  const order = remembered ? [remembered, ...lib.MODEL_ORDER[role].filter((m) => m !== remembered)]
    : lib.MODEL_ORDER[role];
  let lastFailure = null;
  for (const model of order) {
    const token = currentToken();
    if (!token) return { ok: false, errorType: 'no_token', message: 'No Claude Code OAuth token' };
    const result = await callMessages({ ...request, token, model, extra: lib.requestExtrasFor(model) });
    if (result.ok) {
      workingModel[role] = model;
      return { ...result, model };
    }
    if (result.status === 401) dropCachedToken();
    if (!lib.isModelRejection(result)) return result;
    if (workingModel[role] === model) workingModel[role] = null;
    lastFailure = result;
  }
  return lastFailure;
}

// Status the renderer shows: a token is present and the last call didn't fail.
let lastCallOk = null;
function noteOutcome(result) {
  if (result.aborted) return;
  lastCallOk = !!result.ok;
}
function status() {
  return { tokenPresent: !!currentToken(), lastCallOk, models: { ...workingModel } };
}

// Ghost-text completion at the cursor. Resolves { text, model, ms }; text is ''
// when there is nothing to show (no token, skipped, failed, aborted, junk).
async function completeCode({ language, path, prefix = '', suffix = '', snippets }, { signal } = {}) {
  const startedAt = Date.now();
  const empty = (extra = {}) => ({ text: '', model: null, ms: Date.now() - startedAt, ...extra });
  if (lib.shouldSkipCompletion({ prefix, suffix })) return empty({ skipped: true });
  if (!currentToken()) return empty({ error: 'no_token' });
  const prompt = lib.buildCompletionPrompt({ language, path, prefix, suffix, snippets });
  const result = await callWithModelFallback('complete', {
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    maxTokens: 256,
    stopSequences: prompt.stopSequences,
    signal,
  });
  noteOutcome(result);
  if (!result.ok) return empty({ error: result.errorType || 'failed', aborted: !!result.aborted });
  const text = lib.cleanCompletion(result.text, { prefix, suffix });
  return { text, model: result.model, ms: Date.now() - startedAt };
}

// The CLI system prompt is passed on argv, where Windows re-splits around double
// quotes — keep it free of them (see claude.js runCli).
const CLI_EDIT_SYSTEM = `${CC_IDENTITY} You edit code inside an IDE. Output only the requested code `
  + 'wrapped in <replacement></replacement>, with no explanation and no markdown fences.';

// Inline edit (or generation at the cursor when `selection` is empty). Streams raw
// text deltas through `onChunk` and resolves { ok, text, model } with the cleaned
// replacement, or { ok: false, error }. Without an OAuth token it falls back to a
// one-shot `claude -p --model sonnet` (no streaming; refreshes the token too).
async function editCode({ language, path, instruction, selection = '', prefix = '', suffix = '', previous, baseIndent },
  { signal, onChunk } = {}) {
  if (!String(instruction || '').trim()) return { ok: false, error: 'Empty instruction' };
  const prompt = lib.buildEditPrompt({ language, path, instruction, selection, prefix, suffix, previous });
  // `baseIndent` omitted -> the selection's indent; explicitly null -> keep the model's.
  const indent = baseIndent !== undefined ? baseIndent : lib.commonIndent(selection);
  let raw;
  let model;
  if (currentToken()) {
    const result = await callWithModelFallback('edit', {
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 8192,
      stopSequences: prompt.stopSequences,
      stream: true,
      onText: onChunk,
      signal,
    });
    noteOutcome(result);
    if (result.aborted) return { ok: false, error: 'aborted', aborted: true };
    if (!result.ok) return { ok: false, error: result.message || result.errorType || 'Request failed' };
    raw = result.text;
    model = result.model;
  } else {
    raw = await runCli(`${prompt.system}\n\n${prompt.user}`, { model: 'sonnet', systemPrompt: CLI_EDIT_SYSTEM, signal });
    if (signal?.aborted) return { ok: false, error: 'aborted', aborted: true };
    if (raw == null) return { ok: false, error: 'Claude CLI call failed' };
    if (onChunk) onChunk(raw);
    model = 'cli:sonnet';
  }
  const text = lib.cleanEdit(raw, { baseIndent: indent });
  if (text == null) return { ok: false, error: 'The model did not return code' };
  return { ok: true, text, model };
}

// --- IPC -----------------------------------------------------------------------

// In-flight requests by renderer-chosen id, so `ai-cancel` can abort them.
const inFlight = new Map();

function track(id, run) {
  const controller = new AbortController();
  if (id != null) {
    inFlight.get(id)?.abort();
    inFlight.set(id, controller);
  }
  return run(controller.signal).finally(() => {
    if (inFlight.get(id) === controller) inFlight.delete(id);
  });
}

function registerIpc() {
  const { ipcMain } = require('electron');
  ipcMain.handle('ai-complete', (_e, req = {}) => track(req.id, (signal) => completeCode(req, { signal })));
  ipcMain.handle('ai-edit', (event, req = {}) => track(req.id, (signal) => editCode(req, {
    signal,
    // Reply to the requesting renderer only — chunks are not broadcast to remote clients.
    onChunk: (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai-edit-chunk', { id: req.id, text });
    },
  })));
  ipcMain.handle('ai-cancel', (_e, { id } = {}) => {
    inFlight.get(id)?.abort();
    inFlight.delete(id);
  });
  ipcMain.handle('ai-status', () => status());
}

// Only register when loaded inside Electron's main process (plain node has no
// `process.versions.electron`), so smoke tests can require this module directly.
if (process.versions.electron && process.type === 'browser') registerIpc();

module.exports = { completeCode, editCode, status, callWithModelFallback };
