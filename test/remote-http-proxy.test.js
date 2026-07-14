const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { startPortForward } = require('../server/http-proxy');
const { createAuthState, COOKIE } = require('../server/http-proxy-lib');

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('auth-lib decisions: token → redirect+cookie, cookie → proxy, nothing → deny', () => {
  let t = 0;
  const auth = createAuthState(() => t);
  assert.equal(auth.decide('/', '').action, 'deny');

  const token = auth.issueUrlToken();
  const r = auth.decide(`/app?x=1&_ideauth=${token}`, '');
  assert.equal(r.action, 'redirect');
  assert.equal(r.location, '/app?x=1');
  assert.ok(r.setCookie.includes('HttpOnly'));

  assert.equal(auth.decide('/', `${COOKIE}=${auth.cookieValue}`).action, 'proxy');
  assert.equal(auth.decide('/', `${COOKIE}=wrong`).action, 'deny');

  t += 11 * 60 * 1000; // past TTL
  assert.equal(auth.decide(`/?_ideauth=${token}`, '').action, 'deny');
});

test('proxy gates requests and pipes to the target', async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'x-echo-host': req.headers.host });
    res.end(`hello from ${req.url}`);
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  const proxy = await startPortForward({ targetPort, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${proxy.port}`;

    assert.equal((await get(`${base}/`)).status, 403); // no auth

    const token = proxy.issueUrlToken();
    const redirect = await get(`${base}/page?a=b&_ideauth=${token}`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/page?a=b');
    const cookie = redirect.headers['set-cookie'][0].split(';')[0];

    const ok = await get(`${base}/page?a=b`, { cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'hello from /page?a=b');
    assert.equal(ok.headers['x-echo-host'], `127.0.0.1:${targetPort}`); // host rewritten

    // dead target → 502, not a crash
    await new Promise((r) => target.close(r));
    assert.equal((await get(`${base}/`, { cookie })).status, 502);
  } finally { await proxy.close(); }
});

test('proxy passes websocket upgrades through (HMR)', async () => {
  const target = http.createServer();
  const wss = new WebSocketServer({ server: target });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));

  const proxy = await startPortForward({ targetPort: target.address().port, host: '127.0.0.1' });
  try {
    const token = proxy.issueUrlToken();
    const redirect = await get(`http://127.0.0.1:${proxy.port}/?_ideauth=${token}`);
    const cookie = redirect.headers['set-cookie'][0].split(';')[0];

    // without the cookie the upgrade is refused
    await assert.rejects(new Promise((_, rej) => {
      const bad = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`);
      bad.on('error', rej);
    }));

    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, { headers: { cookie } });
    const reply = await new Promise((resolve, reject) => {
      ws.on('error', reject);
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (m) => resolve(m.toString()));
    });
    assert.equal(reply, 'echo:hi');
    ws.close();
  } finally {
    await proxy.close();
    await new Promise((r) => target.close(r));
  }
});
