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

// The toolbar's phone icon rides this: it must hear every authed-client count
// change, and an unauthed socket dropping must not fire it.
test('onClientsChanged reports the authed client count', async () => {
  const counts = [];
  const { hub } = makeHub(undefined, { onClientsChanged: (n) => counts.push(n) });

  const stranger = connect(hub); // never pairs/auths
  await stranger.next();
  stranger.close();
  assert.deepEqual(counts, []);

  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'Phone' });
  const { deviceToken } = await c.next();
  assert.deepEqual(counts, [1]);

  const c2 = connect(hub);
  await c2.next();
  c2.send({ t: 'auth', deviceToken });
  await c2.next();
  assert.deepEqual(counts, [1, 2]);

  c.close();
  c2.close();
  assert.deepEqual(counts, [1, 2, 1, 0]);
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

// One socket carries one identity for its life. Re-pairing to a fresh device would swap
// the client's deviceId, and only the new one would be released on close — stranding
// whatever the first identity held.
test('an identified client cannot re-pair to a new identity', async () => {
  const { hub, deviceStore } = makeHub();
  const c = connect(hub);
  await c.next(); // hello
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'A' });
  await c.next(); // paired
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'B' });
  assert.equal((await c.next()).t, 'auth-err');
  assert.equal(auth.listDevices(deviceStore).length, 1); // token not consumed, no 2nd device
});

// A desktop restart re-announces its phones, which re-auth on the socket they already
// hold — so re-auth to the SAME device is fine, but a different token on that socket is
// an identity swap and must be refused.
test('re-auth to the same device is allowed; a different token is refused', async () => {
  const { hub } = makeHub();
  const c1 = connect(hub); await c1.next();
  c1.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'A' });
  const a = await c1.next(); c1.close();
  const c2 = connect(hub); await c2.next();
  c2.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'B' });
  const b = await c2.next(); c2.close();

  const s = connect(hub); await s.next();
  s.send({ t: 'auth', deviceToken: a.deviceToken });
  assert.equal((await s.next()).deviceId, a.deviceId);
  s.send({ t: 'auth', deviceToken: a.deviceToken });
  assert.equal((await s.next()).t, 'auth-ok'); // idempotent, same identity
  s.send({ t: 'auth', deviceToken: b.deviceToken });
  assert.equal((await s.next()).t, 'auth-err'); // swap refused
});

// A blocked re-pair must not leak the original identity: the socket is still device A,
// so its close reports A exactly once.
test('a blocked re-pair leaves the original identity intact on disconnect', async () => {
  const gone = [];
  const { hub } = makeHub(undefined, { onDisconnect: (id) => gone.push(id) });
  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'A' });
  const a = await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'B' });
  await c.next(); // auth-err
  c.close();
  assert.deepEqual(gone, [a.deviceId]);
});

// One client's send throwing (a dead socket in some transport) must not skip the clients
// after it in the set, nor propagate out of whatever emitted the event.
test('a broadcast survives one client whose send throws', async () => {
  const { hub } = makeHub();
  const bad = hub.connect((msg) => { if (msg.t === 'ev') throw new Error('dead socket'); });
  bad.handle(JSON.stringify({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'bad' }));
  const good = connect(hub); // added to the set after `bad`
  assert.equal((await good.next()).t, 'hello');
  good.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'good' });
  assert.equal((await good.next()).t, 'paired');

  hub.broadcast('folder-changed', { repo: 'C:/x' });
  assert.deepEqual(await good.next(), { t: 'ev', ch: 'folder-changed', payload: { repo: 'C:/x' } });
});

// Stream events (pty-data / term-data / transcript-data) are the relay's bandwidth
// hogs. A client that has sent a `watch` frame receives them only for the ids it
// watches — a chat's pushes must not queue behind another session's terminal bytes.
test('a watching client receives stream events only for watched ids', async () => {
  const { hub } = makeHub();
  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();

  c.send({ t: 'watch', ch: 'transcript-data', id: 's1', on: true });
  hub.broadcast('transcript-data', { id: 's1', messages: [], seq: 1 });
  hub.broadcast('transcript-data', { id: 's2', messages: [], seq: 1 }); // not watched
  hub.broadcast('pty-data', { id: 's1', data: 'x' });                   // stream, not watched
  hub.broadcast('status', { id: 's2', state: 'working' });              // not a stream: always sent

  assert.deepEqual(await c.next(), { t: 'ev', ch: 'transcript-data', payload: { id: 's1', messages: [], seq: 1 } });
  assert.deepEqual(await c.next(), { t: 'ev', ch: 'status', payload: { id: 's2', state: 'working' } });

  // Unwatching turns the stream back off.
  c.send({ t: 'watch', ch: 'transcript-data', id: 's1', on: false });
  hub.broadcast('transcript-data', { id: 's1', messages: [], seq: 2 });
  hub.broadcast('folder-changed', { repo: 'C:/y' });
  assert.equal((await c.next()).ch, 'folder-changed');
});

// An app that predates `watch` never sends one — it must keep receiving every stream
// event, or its console/chat would go silent against a newer desktop.
test('a client that never watches still receives all stream events', async () => {
  const { hub } = makeHub();
  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();

  hub.broadcast('pty-data', { id: 's1', data: 'x' });
  assert.equal((await c.next()).ch, 'pty-data');
});

// A watch frame is authed traffic like everything else, and only stream channels
// can be watched — `folder-changed` filtering would make no sense.
test('watch requires auth and a stream channel', async () => {
  const { hub } = makeHub();
  const stranger = connect(hub);
  await stranger.next();
  stranger.send({ t: 'watch', ch: 'pty-data', id: 's1', on: true });
  assert.equal((await stranger.next()).code, 'not-authed');

  const c = connect(hub);
  await c.next();
  c.send({ t: 'pair', pairToken: hub.pairing.issue(), deviceName: 'P' });
  await c.next();
  c.send({ t: 'watch', ch: 'folder-changed', id: 'x', on: true }); // ignored: not a stream
  hub.broadcast('pty-data', { id: 's1', data: 'x' }); // client still unfiltered
  assert.equal((await c.next()).ch, 'pty-data');
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
