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

// A desktop reconnecting (its socket dropped) inherits phones that are already
// connected. They are blocked waiting on a `hello` only a desktop sends, so the
// returning window has to learn they are there — otherwise they hang against a desktop
// that has never heard of them. It is the *same* window, so it replaces its own stale
// socket; a sibling window would carry a different instance id and be left alone.
// (A desktop that *leaves* is the other test below: its phones are dropped outright,
// and greet the next desktop by reconnecting.)
test('a desktop that replaces its own stale socket is told about the phones already in the room', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=rejoin-room`;
    const desktop = await open(`${base}&role=desktop&instance=win-1`);
    const mobile = await open(`${base}&role=mobile&instance=win-1`);
    const joined = await desktop.next();

    const replaced = new Promise((r) => desktop.ws.on('close', (code) => r(code)));
    const desktop2 = await open(`${base}&role=desktop&instance=win-1`);
    assert.equal(await replaced, 4001);

    const rejoined = await desktop2.next();
    assert.equal(rejoined.joined, true);
    assert.equal(rejoined.c, joined.c);

    // and it can reach that phone over the socket the phone never lost
    desktop2.send({ c: rejoined.c, d: { t: 'hello' } });
    assert.deepEqual(await mobile.next(), { t: 'hello' });
  } finally { await relay.close(); }
});

// The reason a room holds many desktops at all: the IDE runs several windows side by
// side, a phone pairs with the machine once, and each window has to stay reachable.
// Before instance ids, the second window to dial in evicted the first.
test('sibling windows share a room without evicting each other', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=many-windows`;
    const one = await open(`${base}&role=desktop&instance=win-1`);
    const gone = new Promise((r) => one.ws.on('close', () => r('closed')));
    const two = await open(`${base}&role=desktop&instance=win-2`);

    // A phone names the window it wants, and only that window hears it.
    const mobile = await open(`${base}&role=mobile&instance=win-2`);
    const joined = await two.next();
    mobile.send({ t: 'auth', deviceToken: 'x' });
    const env = await two.next();
    assert.equal(env.c, joined.c);
    assert.deepEqual(env.d, { t: 'auth', deviceToken: 'x' });

    two.send({ c: env.c, d: { t: 'auth-ok', deviceId: 'd1' } });
    assert.deepEqual(await mobile.next(), { t: 'auth-ok', deviceId: 'd1' });

    // The first window was never touched — no join, no frame, no eviction.
    assert.equal(await Promise.race([gone, Promise.resolve('alive')]), 'alive');
    assert.equal(one.ws.readyState, one.ws.OPEN);
  } finally { await relay.close(); }
});

// A phone's very first dial cannot name a window: the roster is fetched *over* the
// connection, so before it has one there is nothing to name. It gets the newest window
// and lists from there.
test('a phone that names no window gets the newest one', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=bootstrap`;
    await open(`${base}&role=desktop&instance=win-1`);
    const newest = await open(`${base}&role=desktop&instance=win-2`);

    const mobile = await open(`${base}&role=mobile`);
    const joined = await newest.next();
    assert.equal(joined.joined, true);

    newest.send({ c: joined.c, d: { t: 'hello' } });
    assert.deepEqual(await mobile.next(), { t: 'hello' });
  } finally { await relay.close(); }
});

// Closing one window must not knock the phones off its siblings — the room outlives
// any one of them.
test('mobile sockets are closed when their own desktop leaves, and only theirs', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  try {
    const base = `ws://127.0.0.1:${relay.port}/?room=r2`;
    const one = await open(`${base}&role=desktop&instance=win-1`);
    await open(`${base}&role=desktop&instance=win-2`);
    const onOne = await open(`${base}&role=mobile&instance=win-1`);
    const onTwo = await open(`${base}&role=mobile&instance=win-2`);

    const closed = new Promise((r) => onOne.ws.on('close', (code) => r(code)));
    const survivor = new Promise((r) => onTwo.ws.on('close', () => r('closed')));
    one.ws.close();

    assert.equal(await closed, 4002);
    assert.equal(await Promise.race([survivor, Promise.resolve('alive')]), 'alive');
  } finally { await relay.close(); }
});
