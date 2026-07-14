// End-to-end over the cloud relay, with no Electron and no LAN: a desktop dialling
// out, a phone dialling in, and a browser reaching a dev server that is only
// listening on the desktop's own loopback.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { startRelay } = require('../server/relay');
const { startRelayClient } = require('../server/relay-client');
const { startPortForward } = require('../server/http-proxy');
const { createHub } = require('../server/hub');

// A phone: dial the relay, queue what comes back.
function openMobile(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (m) => ws.send(JSON.stringify(m)),
      next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    }));
  });
}

// One HTTP request, without following redirects — the redirects are what we assert.
//
// `agent: false` so each call is its own TCP connection, which is what the relay
// assumes: it reads one request head, decides where the connection goes, and splices
// it — so a *reused* socket keeps going wherever the first request on it went,
// whatever cookie the later ones carry. A browser never notices, because the entry
// redirect that changes the cookie is answered with `connection: close`. Node's global
// agent keeps sockets alive, so without this a test would silently assert against the
// previous request's tunnel.
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A desktop: a hub, an outbound relay socket, and the port-forward proxies the
// tunnel pipes into — the same wiring src/main/remote.js does.
async function startDesktop({ relayPort, room, instance = 'win-1', invoke = async () => 'ok' }) {
  const devices = [];
  const deviceStore = { load: () => devices, save: (list) => { devices.length = 0; devices.push(...list); } };
  const forwards = new Map();
  const proxyFor = async (targetPort) => {
    if (!forwards.has(targetPort)) forwards.set(targetPort, await startPortForward({ targetPort, host: '127.0.0.1' }));
    return forwards.get(targetPort);
  };
  const relayUrl = `http://127.0.0.1:${relayPort}`;

  const hub = createHub({
    invoke,
    deviceStore,
    appVersion: '1.2.3',
    forward: {
      // The via-aware URL from remote.js: a relayed phone gets an entry URL on the
      // relay, because it cannot reach this machine's own address.
      async open(targetPort, ctx) {
        const proxy = await proxyFor(targetPort);
        const token = proxy.issueUrlToken();
        // Down to the window, not just the machine: a sibling may be proxying this
        // same target port, and the token is only good at the proxy that issued it.
        return ctx.via === 'relay'
          ? `${relayUrl}/p/${room}/${instance}/${targetPort}/?_ideauth=${token}`
          : `http://127.0.0.1:${proxy.port}/?_ideauth=${token}`;
      },
      async close(targetPort) {
        const p = forwards.get(targetPort);
        forwards.delete(targetPort);
        if (p) await p.close();
      },
    },
  });

  const relay = startRelayClient({
    relayUrl, room, instance, hub, tunnel: { localPort: async (p) => (await proxyFor(p)).port },
  });
  return {
    hub,
    close: async () => {
      relay.close();
      await Promise.all([...forwards.values()].map((p) => p.close()));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('a phone pairs, calls and is broadcast to, entirely over the relay', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const room = 'room-e2e-1';
  const calls = [];
  const desktop = await startDesktop({
    relayPort: relay.port,
    room,
    invoke: async (kind, ch, args, ctx) => { calls.push({ kind, ch, args, ctx }); return { echoed: args }; },
  });
  await settle(); // let the desktop's outbound socket land

  const phone = await openMobile(`ws://127.0.0.1:${relay.port}/?role=mobile&room=${room}`);
  try {
    // The desktop speaks first, through the relay, without the phone prompting it.
    assert.deepEqual(await phone.next(), { t: 'hello', protoVersion: 1 });

    phone.send({ t: 'pair', pairToken: desktop.hub.pairing.issue(), deviceName: 'Pixel' });
    const paired = await phone.next();
    assert.equal(paired.t, 'paired');
    assert.ok(paired.deviceToken);

    // An allowlisted channel reaches the desktop's IPC handler, and it can tell the
    // call came in over the relay — which is what picks the port-forward URL.
    phone.send({ t: 'req', id: 1, ch: 'get-repo-path', args: { a: 1 } });
    const res = await phone.next();
    assert.deepEqual(res, { t: 'res', id: 1, ok: true, result: { echoed: { a: 1 } } });
    assert.equal(calls[0].ctx.via, 'relay');
    assert.equal(calls[0].ctx.deviceId, paired.deviceId);

    // A channel that is not on the allowlist is refused at the hub, relay or no relay.
    phone.send({ t: 'req', id: 2, ch: 'open-folder', args: null });
    assert.deepEqual(await phone.next(), { t: 'res', id: 2, ok: false, error: 'channel-denied' });

    // One broadcast reaches relayed clients, not just LAN ones.
    desktop.hub.broadcast('status', { id: 's1', state: 'working' });
    assert.deepEqual(await phone.next(), { t: 'ev', ch: 'status', payload: { id: 's1', state: 'working' } });
  } finally {
    phone.ws.close();
    await desktop.close();
    await relay.close();
  }
});

// The Ports tab, off-LAN. The dev server listens only on the desktop's loopback,
// so every byte the browser sends and receives crosses the relay — and the desktop's
// http-proxy, which cannot tell this browser from one on the LAN.
test('a browser reaches a loopback-only dev server through the relay tunnel', async () => {
  const dev = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`dev server saw ${req.url}`);
  });
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  const devPort = dev.address().port;

  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const room = 'room-e2e-2';
  const desktop = await startDesktop({ relayPort: relay.port, room });
  await settle();

  const phone = await openMobile(`ws://127.0.0.1:${relay.port}/?role=mobile&room=${room}`);
  try {
    await phone.next(); // hello
    phone.send({ t: 'pair', pairToken: desktop.hub.pairing.issue(), deviceName: 'Pixel' });
    await phone.next(); // paired

    phone.send({ t: 'fwd-open', port: devPort });
    const fwd = await phone.next();
    assert.equal(fwd.t, 'fwd-ok');

    // The URL points at the relay, not at this machine — that is the whole point —
    // and names the window, so the bytes land at the proxy that minted the token.
    const url = new URL(fwd.url);
    assert.equal(url.port, String(relay.port));
    assert.equal(url.pathname, `/p/${room}/win-1/${devPort}/`);

    // 1. the entry URL parks the target in a cookie and sends the browser to the root
    const entry = await get(relay.port, url.pathname + url.search);
    assert.equal(entry.status, 302);
    assert.equal(entry.headers.location, `/${url.search}`); // the site root, token intact
    const tunnelCookie = String(entry.headers['set-cookie'][0]).split(';')[0];
    assert.equal(tunnelCookie, `_idetunnel=${room}.win-1.${devPort}`);

    // 2. the root, tunnelled to the desktop's proxy, which swaps the URL token for
    //    its own cookie — proxy logic we did not reimplement and did not touch
    const swap = await get(relay.port, entry.headers.location, { cookie: tunnelCookie });
    assert.equal(swap.status, 302);
    assert.equal(swap.headers.location, '/');
    const authCookie = String(swap.headers['set-cookie'][0]).split(';')[0];
    assert.match(authCookie, /^_ideauth=/);

    // 3. and now the dev server itself, over the relay, with its own paths intact
    const cookies = `${tunnelCookie}; ${authCookie}`;
    const page = await get(relay.port, '/', { cookie: cookies });
    assert.equal(page.status, 200);
    assert.equal(page.body, 'dev server saw /');

    const asset = await get(relay.port, '/assets/app.js?v=1', { cookie: cookies });
    assert.equal(asset.status, 200);
    assert.equal(asset.body, 'dev server saw /assets/app.js?v=1');
  } finally {
    phone.ws.close();
    await desktop.close();
    await relay.close();
    await new Promise((r) => dev.close(r));
  }
});

// An unauthenticated stranger who guesses the relay URL must not reach the dev
// server: the tunnel carries them to the desktop's proxy, which has the last word.
test('the tunnel is not an open door — the desktop proxy still refuses a stranger', async () => {
  const dev = http.createServer((_req, res) => res.end('secret'));
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  const devPort = dev.address().port;

  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const room = 'room-e2e-3';
  const desktop = await startDesktop({ relayPort: relay.port, room });
  await settle();

  const phone = await openMobile(`ws://127.0.0.1:${relay.port}/?role=mobile&room=${room}`);
  try {
    await phone.next();
    phone.send({ t: 'pair', pairToken: desktop.hub.pairing.issue(), deviceName: 'Pixel' });
    await phone.next();
    phone.send({ t: 'fwd-open', port: devPort });
    await phone.next(); // the proxy now exists

    // Right room, right window, right port, no auth token: through the tunnel, and
    // refused there — the relay splices bytes, the desktop's proxy is what guards them.
    const res = await get(relay.port, '/', { cookie: `_idetunnel=${room}.win-1.${devPort}` });
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /secret/);

    // And a cookie naming a window that isn't there never reaches a desktop at all,
    // rather than falling back to whichever one happens to be in the room.
    const wrong = await get(relay.port, '/', { cookie: `_idetunnel=${room}.win-9.${devPort}` });
    assert.equal(wrong.status, 502);
  } finally {
    phone.ws.close();
    await desktop.close();
    await relay.close();
    await new Promise((r) => dev.close(r));
  }
});

test('a tunnel into a room with no desktop is a bad gateway, not a hang', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const res = await get(relay.port, '/', { cookie: '_idetunnel=nobody-home.3000' });
    assert.equal(res.status, 502);
  } finally { await relay.close(); }
});

// The relay's own health check shares the port with everything else, and the
// keep-alive ping depends on it answering.
test('the health check still answers on the shared port', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const res = await get(relay.port, '/healthz');
    assert.equal(res.status, 200);
    assert.match(res.body, /ide-relay ok/);
  } finally { await relay.close(); }
});
