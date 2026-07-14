const { test } = require('node:test');
const assert = require('node:assert');
const { createHub } = require('../server/hub');
const auth = require('../server/auth-lib');

const memStore = () => {
  let list = [];
  return { load: () => list.map((d) => ({ ...d })), save: (next) => { list = next; } };
};

// A client on the hub with no socket under it: collect what the hub sends back,
// let tests await the next message. This is exactly what relay-client.js feeds.
function connect(hub) {
  const queue = [];
  const waiters = [];
  const client = hub.connect((msg) => {
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  return {
    send: (m) => client.handle(JSON.stringify(m)),
    raw: (s) => client.handle(s),
    close: () => client.close(),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
  };
}

function makeHub(invoke, extra = {}) {
  const deviceStore = memStore();
  const hub = createHub({
    invoke: invoke || (async (kind, ch, args) => ({ kind, ch, args })),
    deviceStore,
    appVersion: 'test',
    ...extra,
  });
  return { hub, deviceStore };
}

test('pair → req → ev round trip', async () => {
  const { hub } = makeHub(async (kind, ch) =>
    ch === 'get-recent-folders' ? ['C:/a', 'C:/b'] : null);
  const c = connect(hub);
  assert.equal((await c.next()).t, 'hello');

  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'Test Phone' });
  const paired = await c.next();
  assert.equal(paired.t, 'paired');
  assert.ok(paired.deviceToken);

  c.send({ t: 'req', id: 1, ch: 'get-recent-folders' });
  assert.deepEqual(await c.next(), { t: 'res', id: 1, ok: true, result: ['C:/a', 'C:/b'] });

  hub.broadcast('folder-changed', { repo: 'C:/a' });
  assert.deepEqual(await c.next(), { t: 'ev', ch: 'folder-changed', payload: { repo: 'C:/a' } });
});

// A phone holding a session can't release it if it just vanishes (locked, off Wi-Fi),
// so the desktop has to hear about the dead socket or the session stays covered forever.
test('a dropped socket reports its device as disconnected', async () => {
  const gone = [];
  const { hub } = makeHub(undefined, { onDisconnect: (id) => gone.push(id) });
  const c = connect(hub);
  await c.next(); // hello
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'Phone' });
  const { deviceId } = await c.next();

  c.close();
  assert.deepEqual(gone, [deviceId]);
});

// ...but not while that same device still has another socket open, or reconnecting
// would hand the session back mid-use.
test('a device with another live socket is not reported as disconnected', async () => {
  const gone = [];
  const { hub } = makeHub(undefined, { onDisconnect: (id) => gone.push(id) });
  const c1 = connect(hub);
  await c1.next();
  c1.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'Phone' });
  const { deviceToken } = await c1.next();

  const c2 = connect(hub);
  await c2.next();
  c2.send({ t: 'auth', deviceToken });
  await c2.next();

  c1.close();
  assert.deepEqual(gone, []); // c2 still holds it

  c2.close();
  assert.equal(gone.length, 1);
});

test('auth with paired device token works; bad token rejected', async () => {
  const { hub } = makeHub();
  const c1 = connect(hub);
  await c1.next(); // hello
  c1.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  const { deviceToken, deviceId } = await c1.next();
  c1.close();

  const c2 = connect(hub);
  await c2.next();
  c2.send({ t: 'auth', deviceToken });
  const ok = await c2.next();
  assert.equal(ok.t, 'auth-ok');
  assert.equal(ok.deviceId, deviceId);

  const c3 = connect(hub);
  await c3.next();
  c3.send({ t: 'auth', deviceToken: 'wrong' });
  assert.equal((await c3.next()).t, 'auth-err');
});

test('unauthed and denied requests are rejected', async () => {
  const { hub } = makeHub();
  const c = connect(hub);
  await c.next(); // hello

  c.send({ t: 'req', id: 1, ch: 'get-repo-path' });
  assert.equal((await c.next()).t, 'auth-err'); // not authed

  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();

  c.send({ t: 'req', id: 2, ch: 'open-folder' }); // not on allowlist
  const res = await c.next();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'channel-denied');

  c.raw('garbage');
  assert.equal((await c.next()).code, 'bad-message');
});

test('handler errors surface as res errors, connection survives', async () => {
  const { hub } = makeHub(async () => { throw new Error('boom'); });
  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();
  c.send({ t: 'req', id: 9, ch: 'get-repo-path' });
  assert.deepEqual(await c.next(), { t: 'res', id: 9, ok: false, error: 'boom' });
  c.send({ t: 'req', id: 10, ch: 'get-repo-path' });
  assert.equal((await c.next()).id, 10); // still alive
});

test('fwd-open routes to the injected forward hook; disabled without one', async () => {
  const opened = [];
  const { hub } = makeHub(null, {
    forward: { open: async (port) => { opened.push(port); return `http://x:9/?_ideauth=t${port}`; }, close: async () => {} },
  });
  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();
  c.send({ t: 'fwd-open', port: 3000 });
  assert.deepEqual(await c.next(), { t: 'fwd-ok', port: 3000, url: 'http://x:9/?_ideauth=t3000' });
  assert.deepEqual(opened, [3000]);

  const { hub: bare } = makeHub();
  const b = connect(bare);
  await b.next();
  b.send({ t: 'pair', pairToken: bare.pairing.issue(), deviceName: 'P' });
  await b.next();
  b.send({ t: 'fwd-open', port: 3000 });
  assert.equal((await b.next()).t, 'fwd-err');
});

test('single-use pairing: second pair with same token fails', async () => {
  const { hub, deviceStore } = makeHub();
  const pairToken = hub.pairing.issue();
  const c1 = connect(hub);
  await c1.next();
  c1.send({ t: 'pair', pairToken, deviceName: 'A' });
  assert.equal((await c1.next()).t, 'paired');
  c1.close();

  const c2 = connect(hub);
  await c2.next();
  c2.send({ t: 'pair', pairToken, deviceName: 'B' });
  assert.equal((await c2.next()).t, 'auth-err');
  assert.equal(auth.listDevices(deviceStore).length, 1);
});
