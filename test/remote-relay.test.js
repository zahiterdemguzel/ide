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
    const base = `ws://127.0.0.1:${relay.port}/?room=abc`;
    const desktop = await open(`${base}&role=desktop`);
    const mobile = await open(`${base}&role=mobile`);

    mobile.send({ t: 'auth', deviceToken: 'x' });
    const env = await desktop.next();
    assert.ok(env.c); // clientId assigned by relay
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
