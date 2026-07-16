// A tiny in-process HTTP server that makes the local node-llama-cpp engine look
// like the Anthropic Messages API, so the `claude` CLI — pointed here via
// ANTHROPIC_BASE_URL — can drive a local open-source model. It speaks POST
// /v1/messages (streaming SSE + tool_use) and calls the in-process engine
// (llama-engine.js) directly. All the shape translation lives in the pure,
// unit-tested ollama-translate-lib.js; this file is only socket plumbing. Mirrors
// the structure of hook-server.js.

const http = require('http');
const {
  anthropicToOllama, ollamaChunkToAnthropicEvents, nonStreamToAnthropic,
} = require('./ollama-translate-lib');

let server = null;
let proxyPort = 0;
let msgSeq = 0;

function getProxyPort() { return proxyPort; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sseEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function anthropicError(res, status, message) {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

// Start the proxy once, on an ephemeral 127.0.0.1 port; resolves to the live port
// so the session spawn can put it in ANTHROPIC_BASE_URL. Idempotent.
function startProxyServer() {
  if (server) return Promise.resolve(proxyPort);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => anthropicError(res, 502, err && err.message ? err.message : String(err)));
    });
    server.on('error', (err) => { server = null; reject(err); });
    server.listen(0, '127.0.0.1', () => { proxyPort = server.address().port; resolve(proxyPort); });
  });
}

function stopProxyServer() {
  if (!server) return;
  try { server.close(); } catch { /* already closing */ }
  server = null;
  proxyPort = 0;
}

async function handle(req, res) {
  const url = req.url || '';
  if (req.method === 'POST' && url.startsWith('/v1/messages')) return handleMessages(req, res);
  // The CLI may probe for a model list; an empty list is a harmless 200.
  if (url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return undefined;
  }
  return anthropicError(res, 404, `unsupported path ${url}`);
}

async function handleMessages(req, res) {
  const raw = await readBody(req);
  let anthropicReq;
  try { anthropicReq = JSON.parse(raw); } catch { return anthropicError(res, 400, 'invalid JSON body'); }

  // Lazy require avoids a load-order cycle (ollama.js requires this module).
  const engine = require('./llama-engine');

  const streaming = anthropicReq.stream !== false;
  const ollamaBody = anthropicToOllama(anthropicReq);
  const messageId = `msg_${++msgSeq}_${Date.now()}`;

  // If the CLI hangs up (session killed mid-turn), abort the running generation.
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  if (streaming) return runStreaming(engine, ollamaBody, res, { messageId, model: anthropicReq.model, signal: abort.signal });
  return runBuffered(engine, ollamaBody, res, { messageId, model: anthropicReq.model, signal: abort.signal });
}

async function runStreaming(engine, ollamaBody, res, seed) {
  const state = { messageId: seed.messageId, model: seed.model };
  // Defer the 200/event-stream header until the first chunk actually arrives. A
  // failure *before* any output (most often: the model isn't installed) then comes
  // back as a normal non-200 JSON error the CLI can display — not a 200 stream with
  // only an error event, which the CLI reports as "empty or malformed response".
  let headersSent = false;
  const ensureHead = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  };
  try {
    await engine.chat(ollamaBody, {
      signal: seed.signal,
      onChunk: (chunk) => {
        ensureHead();
        for (const ev of ollamaChunkToAnthropicEvents(chunk, state)) sseEvent(res, ev);
      },
    });
    ensureHead();
    res.end();
  } catch (err) {
    if (seed.signal.aborted) { res.end(); return; }
    const message = err && err.message ? err.message : String(err);
    if (!headersSent) anthropicError(res, 502, message);
    else { sseEvent(res, { type: 'error', error: { type: 'api_error', message } }); res.end(); }
  }
}

async function runBuffered(engine, ollamaBody, res, seed) {
  try {
    const full = await engine.chat({ ...ollamaBody, stream: false }, { signal: seed.signal });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nonStreamToAnthropic(full, { id: seed.messageId, model: seed.model })));
  } catch (err) {
    if (!seed.signal.aborted) anthropicError(res, 502, err && err.message ? err.message : String(err));
    else res.end();
  }
}

module.exports = { startProxyServer, stopProxyServer, getProxyPort };
