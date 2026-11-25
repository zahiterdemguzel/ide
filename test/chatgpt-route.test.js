const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { handleChatgptRequest } = require('../src/main/chatgpt-route');

const LOGIN = { accessToken: 'tok-1', accountId: 'acct-1' };

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// A fake Codex backend plus the route under test, wired together on loopback.
async function withRoute(upstreamHandler, run, { credentials = async () => LOGIN } = {}) {
  const seen = [];
  const fakeBackend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      upstreamHandler(res);
    });
  });
  await new Promise((r) => fakeBackend.listen(0, '127.0.0.1', r));
  const backendPort = fakeBackend.address().port;
  const upstream = { host: '127.0.0.1', request: (opts, cb) => http.request({ ...opts, port: backendPort }, cb) };
  const route = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handleChatgptRequest(req, res, Buffer.concat(chunks), req.url, { credentials, upstream }));
  });
  await new Promise((r) => route.listen(0, '127.0.0.1', r));
  try { await run(route.address().port, seen); } finally { route.close(); fakeBackend.close(); }
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const askBody = { model: 'sol', stream: true, system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] };

test('streams a translated answer and sends the active account login upstream', async () => {
  await withRoute((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_item.done', item: { type: 'message' } },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]));
  }, async (port, seen) => {
    const { status, text } = await post(port, '/v1/messages', askBody);
    assert.equal(status, 200);
    assert.match(text, /event: message_start/);
    assert.match(text, /"text":"Hello"/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);
    assert.equal(seen[0].url, '/backend-api/codex/responses');
    assert.equal(seen[0].headers.authorization, 'Bearer tok-1');
    assert.equal(seen[0].headers['chatgpt-account-id'], 'acct-1');
    assert.equal(seen[0].body.instructions, 'Be brief.');
    assert.equal(seen[0].body.store, false);
    assert.match(seen[0].body.model, /sol/);
  });
});

test('a non-streaming request gets one assembled message with the tool call', async () => {
  await withRoute((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'Bash' } },
      { type: 'response.function_call_arguments.delta', delta: '{"cmd":"ls"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', arguments: '{"cmd":"ls"}' } },
      { type: 'response.completed', response: {} },
    ]));
  }, async (port) => {
    const { status, text } = await post(port, '/v1/messages', { ...askBody, stream: false });
    const message = JSON.parse(text);
    assert.equal(status, 200);
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.content[0], { type: 'tool_use', id: 'c1', name: 'Bash', input: { cmd: 'ls' } });
  });
});

test('a stream cut off before its completed event still ends with message_stop', async () => {
  await withRoute((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([{ type: 'response.output_text.delta', delta: 'partial' }]));
  }, async (port) => {
    const { text } = await post(port, '/v1/messages', askBody);
    assert.match(text, /event: message_stop/);
  });
});

test('an upstream usage limit comes back as an Anthropic rate_limit_error with its status', async () => {
  await withRoute((res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }));
  }, async (port) => {
    const { status, text } = await post(port, '/v1/messages', askBody);
    assert.equal(status, 429);
    assert.equal(JSON.parse(text).error.type, 'rate_limit_error');
  });
});

test('without a usable Codex login the CLI gets a 401 naming where to sign in', async () => {
  await withRoute(() => assert.fail('must not reach upstream'), async (port) => {
    const { status, text } = await post(port, '/v1/messages', askBody);
    assert.equal(status, 401);
    assert.match(JSON.parse(text).error.message, /Codex/);
  }, { credentials: async () => null });
});

test('count_tokens is answered locally and unknown paths are 404', async () => {
  await withRoute(() => assert.fail('must not reach upstream'), async (port) => {
    const counted = await post(port, '/v1/messages/count_tokens', askBody);
    assert.equal(counted.status, 200);
    assert.ok(JSON.parse(counted.text).input_tokens > 0);
    assert.equal((await post(port, '/v1/unknown', {})).status, 404);
  });
});
