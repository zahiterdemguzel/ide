const { test } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startRelay } = require('../server/relay');

function open(url) {
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
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)),
    }));
  });
}

test('relay forwards frames both ways without inspecting them', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=abcdefgh`;
    const desktop = await open(`${base}&role=desktop`);
    const mobile = await open(`${base}&role=mobile`);

    // The desktop speaks first in the IDE protocol, so it must be told a phone is
    // there before that phone sends anything — otherwise both wait forever.
    const joined = await desktop.next();
    assert.ok(joined.c); // clientId assigned by relay
    assert.equal(joined.joined, true);

    mobile.send({ t: 'auth', deviceToken: 'x' });
    const env = await desktop.next();
    assert.equal(env.c, joined.c);
    assert.deepEqual(env.d, { t: 'auth', deviceToken: 'x' });

    desktop.send({ c: env.c, d: { t: 'auth-ok', deviceId: 'd1' } });
    assert.deepEqual(await mobile.next(), { t: 'auth-ok', deviceId: 'd1' });

    // client disconnect notifies the desktop
    mobile.ws.close();
    const gone = await desktop.next();
    assert.equal(gone.c, env.c);
    assert.equal(gone.gone, true);
  } finally { await relay.close(); }
});

// A desktop taking over a room (a second instance dialling in) inherits phones that
// are already connected. They are blocked waiting on a `hello` only a desktop sends,
// so the newcomer has to learn they are there — otherwise they hang against a desktop
// that has never heard of them. (A desktop that *leaves* is the other test below: its
// phones are dropped outright, and greet the next desktop by reconnecting.)
test('a desktop that replaces another is told about the phones already in the room', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=rejoin-room`;
    const desktop = await open(`${base}&role=desktop`);
    const mobile = await open(`${base}&role=mobile`);
    const joined = await desktop.next();

    // A second desktop takes the room. The first is dropped; its phones are not —
    // so the newcomer inherits a phone it has never greeted.
    const replaced = new Promise((r) => desktop.ws.on('close', (code) => r(code)));
    const desktop2 = await open(`${base}&role=desktop`);
    assert.equal(await replaced, 4001);

    const rejoined = await desktop2.next();
    assert.equal(rejoined.joined, true);
    assert.equal(rejoined.c, joined.c);

    // and it can reach that phone over the socket the phone never lost
    desktop2.send({ c: rejoined.c, d: { t: 'hello' } });
    assert.deepEqual(await mobile.next(), { t: 'hello' });
  } finally { await relay.close(); }
});

test('mobile sockets are closed when the desktop leaves', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=r2`;
    const desktop = await open(`${base}&role=desktop`);
    const mobile = await open(`${base}&role=mobile`);
    const closed = new Promise((r) => mobile.ws.on('close', (code) => r(code)));
    desktop.ws.close();
    assert.equal(await closed, 4002);
  } finally { await relay.close(); }
});
