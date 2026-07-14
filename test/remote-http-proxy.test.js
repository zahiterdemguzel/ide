const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { startPortForward } = require('../server/http-proxy');
const {
  createAuthState, rewriteLocation, rewriteSetCookie, normalizeForwardPath, COOKIE,
} = require('../server/http-proxy-lib');

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

test('a redirect to the dev server\'s own localhost becomes a path the phone can follow', () => {
  // /admin → /login, built by the dev server from the Host we gave it.
  assert.equal(rewriteLocation('http://127.0.0.1:3000/login?next=/admin', 3000), '/login?next=/admin');
  assert.equal(rewriteLocation('http://localhost:3000', 3000), '/');
  assert.equal(rewriteLocation('/login', 3000), '/login'); // already relative
  // Not ours to rewrite: another local service, or somewhere else entirely.
  assert.equal(rewriteLocation('http://127.0.0.1:9999/x', 3000), 'http://127.0.0.1:9999/x');
  assert.equal(rewriteLocation('https://accounts.google.com/o/oauth2', 3000), 'https://accounts.google.com/o/oauth2');
});

test('a login cookie the phone could not keep is made keepable', () => {
  assert.equal(rewriteSetCookie('sid=abc; Domain=localhost; Path=/; HttpOnly; Secure'), 'sid=abc; Path=/; HttpOnly');
  assert.equal(rewriteSetCookie('sid=abc; Path=/'), 'sid=abc; Path=/');
  // SameSite=None is rejected by browsers without Secure, so the pair survives.
  assert.equal(rewriteSetCookie('sid=abc; SameSite=None; Secure'), 'sid=abc; SameSite=None; Secure');
});

test('a forward path is kept a path on this site', () => {
  assert.equal(normalizeForwardPath('/admin'), '/admin');
  assert.equal(normalizeForwardPath('admin'), '/admin');
  assert.equal(normalizeForwardPath('/login?next=/x'), '/login?next=/x');
  assert.equal(normalizeForwardPath(undefined), '');
  assert.equal(normalizeForwardPath('/'), '');
  // Never off to another origin with the auth token in hand.
  assert.equal(normalizeForwardPath('//evil.example.com/x'), '/evil.example.com/x');
  assert.equal(normalizeForwardPath('https://evil.example.com'), '');
  assert.equal(normalizeForwardPath('/x\r\nHost: evil'), '');
});

test('once a port is open, any path on it is reachable (the /login, /admin walk)', async () => {
  const target = http.createServer((req, res) => {
    if (req.url === '/admin') { // the redirect a framework builds from our Host header
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/login`, 'set-cookie': 'sid=1; Domain=localhost; Secure' });
      return res.end();
    }
    res.writeHead(200);
    res.end(`page ${req.url}`);
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  const proxy = await startPortForward({ targetPort, host: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${proxy.port}`;

    // Land directly on a deep path: the token is stripped, the path is kept.
    const entry = await get(`${base}/admin?_ideauth=${proxy.issueUrlToken()}`);
    assert.equal(entry.headers.location, '/admin');
    const cookie = entry.headers['set-cookie'][0].split(';')[0];

    // The dev server's own redirect is followable by the phone, and its cookie keepable.
    const redirected = await get(`${base}/admin`, { cookie });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.location, '/login'); // not http://127.0.0.1:<port>/login
    assert.equal(redirected.headers['set-cookie'][0], 'sid=1');

    // And the cookie from the first hit carries to any other path — the bridge.
    assert.equal((await get(`${base}/login`, { cookie })).body, 'page /login');
    assert.equal((await get(`${base}/deep/nested?q=1`, { cookie })).body, 'page /deep/nested?q=1');
  } finally {
    await proxy.close();
    await new Promise((r) => target.close(r));
  }
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
