const { test } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startRemoteServer } = require('../server/ws-server');
const auth = require('../server/auth-lib');

const memStore = () => {
  let list = [];
  return { load: () => list.map((d) => ({ ...d })), save: (next) => { list = next; } };
};

// Minimal client: collects messages, lets tests await the next one.
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
      close: () => ws.close(),
    }));
  });
}

async function startTestServer(invoke, extra = {}) {
  const deviceStore = memStore();
  const server = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    deviceStore,
    appVersion: 'test',
    invoke: invoke || (async (kind, ch, args) => ({ kind, ch, args })),
    ...extra,
  });
  return { server, deviceStore };
}

test('pair → req → ev round trip', async () => {
  const { server } = await startTestServer(async (kind, ch) =>
    ch === 'get-recent-folders' ? ['C:/a', 'C:/b'] : null);
  try {
    const c = await connect(server.port);
    assert.equal((await c.next()).t, 'hello');

    const pairToken = server.pairing.issue();
    c.send({ t: 'pair', pairToken, deviceName: 'Test Phone' });
    const paired = await c.next();
    assert.equal(paired.t, 'paired');
    assert.ok(paired.deviceToken);

    c.send({ t: 'req', id: 1, ch: 'get-recent-folders' });
    assert.deepEqual(await c.next(), { t: 'res', id: 1, ok: true, result: ['C:/a', 'C:/b'] });

    server.broadcast('folder-changed', { repo: 'C:/a' });
    assert.deepEqual(await c.next(), { t: 'ev', ch: 'folder-changed', payload: { repo: 'C:/a' } });
    c.close();
  } finally { await server.close(); }
});

// A phone holding a session can't release it if it just vanishes (locked, off Wi-Fi),
// so the desktop has to hear about the dead socket or the session stays covered forever.
test('a dropped socket reports its device as disconnected', async () => {
  const gone = [];
  const { server } = await startTestServer(undefined, { onDisconnect: (id) => gone.push(id) });
  try {
    const c = await connect(server.port);
    await c.next(); // hello
    c.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'Phone' });
    const { deviceId } = await c.next();

    c.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(gone, [deviceId]);
  } finally { await server.close(); }
});

// ...but not while that same device still has another socket open, or reconnecting
// would hand the session back mid-use.
test('a device with another live socket is not reported as disconnected', async () => {
  const gone = [];
  const { server } = await startTestServer(undefined, { onDisconnect: (id) => gone.push(id) });
  try {
    const c1 = await connect(server.port);
    await c1.next();
    c1.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'Phone' });
    const { deviceToken } = await c1.next();

    const c2 = await connect(server.port);
    await c2.next();
    c2.send({ t: 'auth', deviceToken });
    await c2.next();

    c1.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(gone, []); // c2 still holds it

    c2.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gone.length, 1);
  } finally { await server.close(); }
});

test('auth with paired device token works; bad token rejected', async () => {
  const { server } = await startTestServer();
  try {
    const c1 = await connect(server.port);
    await c1.next(); // hello
    c1.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'P' });
    const { deviceToken, deviceId } = await c1.next();
    c1.close();

    const c2 = await connect(server.port);
    await c2.next();
    c2.send({ t: 'auth', deviceToken });
    const ok = await c2.next();
    assert.equal(ok.t, 'auth-ok');
    assert.equal(ok.deviceId, deviceId);
    c2.close();

    const c3 = await connect(server.port);
    await c3.next();
    c3.send({ t: 'auth', deviceToken: 'wrong' });
    assert.equal((await c3.next()).t, 'auth-err');
    c3.close();
  } finally { await server.close(); }
});

test('unauthed and denied requests are rejected', async () => {
  const { server } = await startTestServer();
  try {
    const c = await connect(server.port);
    await c.next(); // hello

    c.send({ t: 'req', id: 1, ch: 'get-repo-path' });
    assert.equal((await c.next()).t, 'auth-err'); // not authed

    c.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'P' });
    await c.next();

    c.send({ t: 'req', id: 2, ch: 'open-folder' }); // not on allowlist
    const res = await c.next();
    assert.equal(res.ok, false);
    assert.equal(res.error, 'channel-denied');

    c.send('garbage');
    assert.equal((await c.next()).code, 'bad-message');
    c.close();
  } finally { await server.close(); }
});

test('handler errors surface as res errors, connection survives', async () => {
  const { server } = await startTestServer(async () => { throw new Error('boom'); });
  try {
    const c = await connect(server.port);
    await c.next();
    c.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'P' });
    await c.next();
    c.send({ t: 'req', id: 9, ch: 'get-repo-path' });
    const res = await c.next();
    assert.deepEqual(res, { t: 'res', id: 9, ok: false, error: 'boom' });
    c.send({ t: 'req', id: 10, ch: 'get-repo-path' });
    assert.equal((await c.next()).id, 10); // still alive
    c.close();
  } finally { await server.close(); }
});

test('fwd-open routes to the injected forward hook; disabled without one', async () => {
  const opened = [];
  const { server } = await startTestServer(null, {
    forward: { open: async (port) => { opened.push(port); return `http://x:9/?_ideauth=t${port}`; }, close: async () => {} },
  });
  try {
    const c = await connect(server.port);
    await c.next();
    c.send({ t: 'pair', pairToken: server.pairing.issue(), deviceName: 'P' });
    await c.next();
    c.send({ t: 'fwd-open', port: 3000 });
    assert.deepEqual(await c.next(), { t: 'fwd-ok', port: 3000, url: 'http://x:9/?_ideauth=t3000' });
    assert.deepEqual(opened, [3000]);
    c.close();
  } finally { await server.close(); }

  const { server: bare } = await startTestServer();
  try {
    const c = await connect(bare.port);
    await c.next();
    c.send({ t: 'pair', pairToken: bare.pairing.issue(), deviceName: 'P' });
    await c.next();
    c.send({ t: 'fwd-open', port: 3000 });
    assert.equal((await c.next()).t, 'fwd-err');
    c.close();
  } finally { await bare.close(); }
});

test('single-use pairing: second pair with same token fails', async () => {
  const { server, deviceStore } = await startTestServer();
  try {
    const pairToken = server.pairing.issue();
    const c1 = await connect(server.port);
    await c1.next();
    c1.send({ t: 'pair', pairToken, deviceName: 'A' });
    assert.equal((await c1.next()).t, 'paired');
    c1.close();

    const c2 = await connect(server.port);
    await c2.next();
    c2.send({ t: 'pair', pairToken, deviceName: 'B' });
    assert.equal((await c2.next()).t, 'auth-err');
    c2.close();
    assert.equal(auth.listDevices(deviceStore).length, 1);
  } finally { await server.close(); }
});
