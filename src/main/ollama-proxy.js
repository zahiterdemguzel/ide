// A tiny in-process HTTP server that makes a local Ollama engine look like the
// Anthropic Messages API, so the `claude` CLI — pointed here via ANTHROPIC_BASE_URL
// — can drive a local open-source model. It speaks POST /v1/messages (streaming
// SSE + tool_use) and forwards to `ollama serve`'s /api/chat. All the shape
// translation lives in the pure, unit-tested ollama-translate-lib.js; this file is
// only socket plumbing. Mirrors the structure of hook-server.js.

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

  // Lazy require avoids a load-order cycle (ollama.js starts this server).
  const base = require('./ollama').getServeBase();
  if (!base) return anthropicError(res, 503, 'ollama engine not running');

  const streaming = anthropicReq.stream !== false;
  const ollamaBody = anthropicToOllama(anthropicReq);
  const messageId = `msg_${++msgSeq}_${Date.now()}`;

  const u = new URL('/api/chat', base);
  const upstream = http.request(
    { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } },
    (oRes) => {
      oRes.setEncoding('utf8');
      if (streaming) streamResponse(oRes, res, { messageId, model: anthropicReq.model });
      else bufferResponse(oRes, res, { messageId, model: anthropicReq.model });
    },
  );
  upstream.on('error', (err) => anthropicError(res, 502, err && err.message ? err.message : String(err)));
  // If the CLI hangs up (session killed mid-turn), stop pulling from the engine.
  res.on('close', () => upstream.destroy());

  upstream.write(JSON.stringify(ollamaBody));
  upstream.end();
  return undefined;
}

function streamResponse(oRes, res, seed) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const state = { messageId: seed.messageId, model: seed.model };
  let buf = '';
  const drain = (line) => {
    const s = line.trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch { return; }
    if (obj.error) { sseEvent(res, { type: 'error', error: { type: 'api_error', message: String(obj.error) } }); return; }
    for (const ev of ollamaChunkToAnthropicEvents(obj, state)) sseEvent(res, ev);
  };
  oRes.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      drain(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  oRes.on('end', () => { drain(buf); res.end(); });
  oRes.on('error', () => res.end());
}

function bufferResponse(oRes, res, seed) {
  let body = '';
  oRes.on('data', (c) => { body += c; });
  oRes.on('end', () => {
    let obj;
    try { obj = JSON.parse(body); } catch { return anthropicError(res, 502, 'invalid upstream response'); }
    if (obj.error) return anthropicError(res, 502, String(obj.error));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nonStreamToAnthropic(obj, { id: seed.messageId, model: seed.model })));
    return undefined;
  });
  oRes.on('error', () => anthropicError(res, 502, 'upstream stream error'));
}

module.exports = { startProxyServer, stopProxyServer, getProxyPort };
