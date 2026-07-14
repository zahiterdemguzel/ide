const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resolveKeepAlive, startSelfPing, DEFAULT_INTERVAL_MS } = require('../server/keepalive');
const { startRelay } = require('../server/relay');

test('resolveKeepAlive reads Render env vars, off when absent', () => {
  assert.equal(resolveKeepAlive({}), null);

  assert.deepEqual(resolveKeepAlive({ RENDER_EXTERNAL_URL: 'https://ide-relay.onrender.com' }), {
    url: 'https://ide-relay.onrender.com/healthz',
    intervalMs: DEFAULT_INTERVAL_MS,
  });

  assert.equal(
    resolveKeepAlive({ RENDER_EXTERNAL_HOSTNAME: 'ide-relay.onrender.com' }).url,
    'https://ide-relay.onrender.com/healthz',
  );

  // Explicit overrides win; a non-positive interval disables the ping.
  const custom = resolveKeepAlive({ RENDER_EXTERNAL_URL: 'https://a.dev', KEEPALIVE_URL: 'https://b.dev', KEEPALIVE_INTERVAL_MS: '1000' });
  assert.deepEqual(custom, { url: 'https://b.dev/healthz', intervalMs: 1000 });
  assert.equal(resolveKeepAlive({ RENDER_EXTERNAL_URL: 'https://a.dev', KEEPALIVE_INTERVAL_MS: '0' }), null);
});

test('startSelfPing hits the url on the interval and survives failures', async () => {
  const hits = [];
  const logs = [];
  const fetchImpl = async (url) => {
    hits.push(url);
    if (hits.length === 1) throw new Error('boom');
    return { status: 200 };
  };
  const { ping, stop } = startSelfPing({ url: 'https://a.dev/healthz', intervalMs: 5, fetchImpl, log: (m) => logs.push(m) });

  await ping();
  await ping();
  stop();

  assert.deepEqual(hits, ['https://a.dev/healthz', 'https://a.dev/healthz']);
  assert.match(logs[0], /failed: boom/);
  assert.match(logs[1], /-> 200/);
});

test('relay answers the health path the ping targets', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${relay.port}/healthz`, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve(out));
    }).on('error', reject);
  });
  await relay.close();
  assert.match(body, /^ide-relay ok rooms=0/);
});
