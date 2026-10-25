const { test, after } = require('node:test');
const assert = require('node:assert');
const { splitFrame, createFrameAssembler } = require('../server/p2p-lib');
const { createP2pHost } = require('../server/p2p-host');
const { createHub } = require('../server/hub');
const auth = require('../server/auth-lib');

const memStore = () => {
  let list = [];
  return { load: () => list.map((d) => ({ ...d })), save: (next) => { list = next; } };
};

test('a small frame goes whole; a large one splits and reassembles exactly', () => {
  assert.deepEqual(splitFrame('{"t":"x"}', 64), ['{"t":"x"}']);
  const big = JSON.stringify({ t: 'ev', payload: 'é'.repeat(1000) });
  const parts = splitFrame(big, 100);
  assert.ok(parts.length > 1);
  assert.ok(parts.slice(0, -1).every((p) => p[0] === '+'));
  assert.equal(parts.at(-1)[0], '.');

  const got = [];
  const assemble = createFrameAssembler((f) => got.push(f));
  for (const p of parts) assemble(p);
  assemble('{"t":"after"}');
  assert.deepEqual(got, [big, '{"t":"after"}']);
});

test('a whole frame arriving mid-split drops the orphaned parts', () => {
  const got = [];
  const assemble = createFrameAssembler((f) => got.push(f));
  assemble('+{"t":');
  assemble('{"t":"whole"}');
  assemble('.{"t":"tail"}');
  assert.deepEqual(got, ['{"t":"whole"}', '{"t":"tail"}']);
});

// The hub hands signaling only to an authed socket, and answers `rtc-unavailable`
// when the desktop has no WebRTC module — the phone then stays on the relay.
test('hub gates signaling behind auth and reports a missing p2p host', async () => {
  const deviceStore = memStore();
  const { token } = auth.createDevice(deviceStore, 'Phone');
  const out = [];
  const hub = createHub({ invoke: async () => null, deviceStore });
  const client = hub.connect((m) => out.push(m));
  await client.handle(JSON.stringify({ t: 'rtc-offer', sdp: 'x' }));
  assert.equal(out.at(-1).code, 'not-authed');
  await client.handle(JSON.stringify({ t: 'auth', deviceToken: token }));
  await client.handle(JSON.stringify({ t: 'rtc-offer', sdp: 'x' }));
  assert.deepEqual(out.at(-1), { t: 'rtc-unavailable' });
});

test('closing the signaling socket releases its negotiation', async () => {
  const deviceStore = memStore();
  const { token } = auth.createDevice(deviceStore, 'Phone');
  const calls = [];
  const p2p = { signal: (no, msg) => calls.push(['signal', no, msg.t]), release: (no) => calls.push(['release', no]) };
  const hub = createHub({ invoke: async () => null, deviceStore, p2p });
  const client = hub.connect(() => {});
  await client.handle(JSON.stringify({ t: 'auth', deviceToken: token }));
  await client.handle(JSON.stringify({ t: 'rtc-offer', sdp: 'x' }));
  client.close();
  assert.equal(calls[0][0], 'signal');
  assert.deepEqual(calls[1], ['release', calls[0][1]]);
});

// The real thing over loopback: a "phone" peer offers through the hub's signaling,
// the host answers, and the hub protocol then runs over the data channel —
// including a frame big enough to need splitting.
let nodeDataChannel = null;
try { nodeDataChannel = require('node-datachannel'); } catch { /* prebuild missing: skip */ }
after(() => nodeDataChannel?.cleanup());

test('a phone peer reaches ready over a direct data channel', { skip: !nodeDataChannel, timeout: 15000 }, async () => {
  const { PeerConnection } = nodeDataChannel;
  const deviceStore = memStore();
  const { token } = auth.createDevice(deviceStore, 'Phone');
  const bigResult = 'x'.repeat(300 * 1024);
  let p2p = null;
  const hub = createHub({ invoke: async () => bigResult, deviceStore, p2p: { signal: (...a) => p2p.signal(...a), release: (no) => p2p.release(no) } });
  p2p = createP2pHost({ hub, PeerConnection, iceServers: [] });

  const signaling = hub.connect((msg) => onSignal(msg));
  await signaling.handle(JSON.stringify({ t: 'auth', deviceToken: token }));

  const phone = new PeerConnection('phone', { iceServers: [] });
  function onSignal(msg) {
    if (msg.t === 'rtc-answer') phone.setRemoteDescription(msg.sdp, 'answer');
    if (msg.t === 'rtc-ice') phone.addRemoteCandidate(msg.candidate, msg.mid);
  }
  phone.onLocalDescription((sdp) => signaling.handle(JSON.stringify({ t: 'rtc-offer', sdp })));
  phone.onLocalCandidate((candidate, mid) => signaling.handle(JSON.stringify({ t: 'rtc-ice', candidate, mid })));
  // Creating the channel is what starts negotiation, so the callbacks come first.
  const channel = phone.createDataChannel('ide');

  const frames = [];
  const waiters = [];
  const assemble = createFrameAssembler((text) => {
    const msg = JSON.parse(text);
    const w = waiters.shift();
    if (w) w(msg); else frames.push(msg);
  });
  channel.onMessage((m) => assemble(String(m)));
  const next = () => (frames.length ? Promise.resolve(frames.shift()) : new Promise((r) => waiters.push(r)));
  const send = (m) => { for (const part of splitFrame(JSON.stringify(m))) channel.sendMessage(part); };

  assert.equal((await next()).t, 'hello');
  send({ t: 'auth', deviceToken: token });
  assert.equal((await next()).t, 'auth-ok');
  // The signaling socket can go now: the link is a client of its own.
  signaling.close();
  assert.equal(p2p.linkCount(), 1);
  send({ t: 'req', id: 7, ch: 'get-recent-folders' });
  const res = await next();
  assert.equal(res.id, 7);
  assert.equal(res.result.length, bigResult.length);

  p2p.closeAll();
  phone.close();
  assert.equal(p2p.linkCount(), 0);
});
