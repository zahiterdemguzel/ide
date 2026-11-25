// The `/g` route of the account proxy: Claude Code on a ChatGPT login. Electron-free
// so it can be tested end to end against a local fake upstream (see
// test/chatgpt-route.test.js). The request is translated to the Codex backend's
// Responses API, sent with the active Codex account's login, and the event stream is
// translated back — the shape mapping itself lives in chatgpt-translate-lib.js.

const https = require('https');
const lib = require('./chatgpt-translate-lib');
const { codexModelName, resolveCurrentModelId } = require('./agent-providers');
const { credentialHeaders, CODEX_UPSTREAM_HOST, PROVIDER_CODEX } = require('./provider-accounts-lib');

let messageSeq = 0;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sseWrite(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function readText(stream) {
  return new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => { text += d; });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

function parseJson(buffer) {
  try { return JSON.parse(buffer.toString('utf8') || '{}'); } catch { return null; }
}

// `options.credentials()` resolves the active Codex login ({accessToken, accountId}) or null;
// `options.track(upstreamRequest)` lets the caller cancel it; `options.upstream` overrides
// the transport (tests): { request(options, callback), host }.
async function handleChatgptRequest(req, res, body, path, options) {
  const { track, credentials, upstream = { request: https.request, host: CODEX_UPSTREAM_HOST } } = options;
  if (req.method === 'GET' && path.startsWith('/v1/models')) { sendJson(res, 200, { data: [] }); return; }
  const request = parseJson(body);
  if (req.method === 'POST' && /^\/v1\/messages\/count_tokens/.test(path)) {
    sendJson(res, 200, { input_tokens: lib.estimateInputTokens(request || {}) });
    return;
  }
  if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(path) || !request) {
    sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `unsupported path ${path}` } });
    return;
  }
  const login = await credentials();
  if (!login) {
    sendJson(res, 401, lib.anthropicErrorFor(401, JSON.stringify({ error: { message: 'No usable ChatGPT login: sign in under Account → Codex.' } })));
    return;
  }
  const modelName = codexModelName(resolveCurrentModelId(`codex:${lib.chatgptFamilyOf(request.model)}`));
  const payload = Buffer.from(JSON.stringify(lib.anthropicToResponses(request, modelName)));
  const upstreamRes = await new Promise((resolve, reject) => {
    const outgoing = upstream.request({
      host: upstream.host,
      path: lib.CODEX_RESPONSES_PATH,
      method: 'POST',
      headers: {
        ...credentialHeaders(PROVIDER_CODEX, login),
        'content-type': 'application/json', 'content-length': String(payload.length),
        accept: 'text/event-stream', 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs',
      },
    }, resolve);
    outgoing.on('error', reject);
    if (track) track(outgoing);
    outgoing.end(payload);
  });
  if (res.destroyed) { upstreamRes.resume(); return; }
  if (upstreamRes.statusCode !== 200) {
    sendJson(res, upstreamRes.statusCode, lib.anthropicErrorFor(upstreamRes.statusCode, await readText(upstreamRes)));
    return;
  }
  await relayStream(upstreamRes, res, request);
}

// Translates the upstream event stream into the CLI's stream (or, for a request that
// didn't ask to stream, one message).
async function relayStream(upstreamRes, res, request) {
  const messageId = `msg_gpt_${++messageSeq}_${Date.now()}`;
  const state = lib.newStreamState({ messageId, model: request.model });
  const streaming = request.stream !== false;
  const collected = [];
  const emit = (event) => { if (streaming) sseWrite(res, event); else collected.push(event); };
  if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  upstreamRes.setEncoding('utf8');
  const parser = lib.createSseParser((event) => { for (const out of lib.responsesEventToAnthropic(event, state)) emit(out); });
  upstreamRes.on('data', (chunk) => parser.feed(chunk));
  await new Promise((resolve) => { upstreamRes.on('end', resolve); upstreamRes.on('close', resolve); });
  // A stream that ended without its completed event still has to end properly for the CLI.
  if (!state.finished) for (const out of lib.responsesEventToAnthropic({ type: 'response.completed', response: {} }, state)) emit(out);
  if (streaming) { res.end(); return; }
  const failed = collected.find((e) => e.type === 'error');
  if (failed) { sendJson(res, 502, failed); return; }
  sendJson(res, 200, lib.foldEventsToMessage(collected, lib.newStreamState({ messageId, model: request.model })));
}

module.exports = { handleChatgptRequest };
