// The remote-client state machine, with no socket under it. One hub owns the
// pairing state, the set of authed clients and the broadcast fan-out; a client
// is just a `send` function plus the frames it hands back. Phones reach the
// desktop over the cloud relay (relay-client.js), and one broadcast reaches
// every one of them.

const proto = require('./protocol');
const auth = require('./auth-lib');
const { debugFor } = require('./debug');

const debug = debugFor('hub');

let nextClientNo = 1;

// opts: { invoke, deviceStore, appVersion, forward, onDisconnect, pairing }
function createHub(opts) {
  const { invoke, deviceStore, appVersion = '' } = opts;
  const pairing = opts.pairing || auth.createPairingState();
  const clients = new Set(); // authed clients

  // Connect a transport. `send` takes a message object. Returns the client:
  // feed it raw frames, close it when the socket dies.
  function connect(send) {
    const client = { deviceId: null, send, open: true, no: nextClientNo++ };
    const trace = (msg, fields) => debug(msg, { c: client.no, ...fields });

    const reply = (msg) => { if (client.open) send(msg); };
    trace('connect → hello');
    reply(proto.hello());

    async function handle(raw) {
      const msg = proto.parseMessage(String(raw));
      if (!msg) {
        trace('rx bad-message', { bytes: String(raw).length });
        return reply(proto.authErr(proto.ERR.BAD_MESSAGE));
      }
      trace('rx', { t: msg.t, ch: msg.ch, id: msg.id, port: msg.port });

      if (msg.t === 'pair') {
        if (!pairing.consume(msg.pairToken)) {
          trace('pair rejected', { reason: proto.ERR.BAD_TOKEN });
          return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        }
        const { device, token } = auth.createDevice(deviceStore, msg.deviceName);
        client.deviceId = device.id;
        clients.add(client);
        trace('paired', { device: device.id, name: device.name, clients: clients.size });
        return reply(proto.paired(token, device.id));
      }
      if (msg.t === 'auth') {
        const device = auth.verifyDevice(deviceStore, msg.deviceToken);
        if (!device) {
          trace('auth rejected', { reason: proto.ERR.BAD_TOKEN });
          return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        }
        client.deviceId = device.id;
        clients.add(client);
        trace('authed', { device: device.id, name: device.name, clients: clients.size });
        return reply(proto.authOk(device.id, appVersion));
      }

      if (!client.deviceId) {
        trace('rejected', { t: msg.t, reason: proto.ERR.NOT_AUTHED });
        return reply(proto.authErr(proto.ERR.NOT_AUTHED));
      }
      const ctx = { deviceId: client.deviceId };

      if (msg.t === 'req') {
        if (!proto.canCall('req', msg.ch)) {
          trace('req denied', { ch: msg.ch, reason: proto.ERR.CHANNEL_DENIED });
          return reply(proto.resErr(msg.id, proto.ERR.CHANNEL_DENIED));
        }
        const started = Date.now();
        try {
          const result = await invoke('req', msg.ch, msg.args, ctx);
          trace('req ok', { ch: msg.ch, id: msg.id, ms: Date.now() - started });
          reply(proto.resOk(msg.id, result));
        } catch (err) {
          const error = String((err && err.message) || err);
          trace('req failed', { ch: msg.ch, id: msg.id, ms: Date.now() - started, error });
          reply(proto.resErr(msg.id, error));
        }
        return;
      }
      if (msg.t === 'send') {
        if (!proto.canCall('send', msg.ch)) {
          trace('send denied', { ch: msg.ch, reason: proto.ERR.CHANNEL_DENIED });
          return;
        }
        try {
          invoke('send', msg.ch, msg.args, ctx);
          trace('send', { ch: msg.ch });
        } catch (err) {
          trace('send failed', { ch: msg.ch, error: String((err && err.message) || err) });
        }
        return;
      }

      // Port forwarding: the embedder injects `forward`; without it the feature
      // is off. open() mints a relay entry URL the phone's browser can reach.
      if (msg.t === 'fwd-open') {
        if (!opts.forward) {
          trace('fwd-open denied', { port: msg.port, reason: 'forwarding-disabled' });
          return reply(proto.fwdErr(msg.port, 'forwarding-disabled'));
        }
        try {
          const url = await opts.forward.open(msg.port, ctx, msg.path);
          trace('fwd-open ok', { port: msg.port, path: msg.path });
          reply(proto.fwdOk(msg.port, url));
        } catch (err) {
          const error = String((err && err.message) || err);
          trace('fwd-open failed', { port: msg.port, error });
          reply(proto.fwdErr(msg.port, error));
        }
        return;
      }
      if (msg.t === 'fwd-close') {
        trace('fwd-close', { port: msg.port });
        if (opts.forward) { try { await opts.forward.close(msg.port, ctx); } catch {} }
      }
    }

    function close() {
      if (!client.open) return;
      client.open = false;
      clients.delete(client);
      // A device that vanishes (locked phone, dropped Wi-Fi) can't release what it
      // was holding, so tell the embedder which one left — but only once it's
      // really gone: the same device may hold another live socket (a reconnect).
      if (client.deviceId && opts.onDisconnect) {
        const stillHere = [...clients].some((c) => c.deviceId === client.deviceId);
        trace('closed', { device: client.deviceId, clients: clients.size, stillHere });
        if (!stillHere) { try { opts.onDisconnect(client.deviceId); } catch {} }
        return;
      }
      trace('closed', { device: client.deviceId, clients: clients.size });
    }

    return { handle, close, get deviceId() { return client.deviceId; } };
  }

  function broadcast(ch, payload) {
    if (!proto.isRemoteEvent(ch) || clients.size === 0) {
      if (debug.on && !proto.isRemoteEvent(ch)) debug('broadcast dropped', { ch, reason: 'not-a-remote-event' });
      return;
    }
    debug('broadcast', { ch, clients: clients.size });
    const msg = proto.ev(ch, payload);
    for (const c of clients) c.send(msg);
  }

  return {
    connect,
    broadcast,
    pairing,
    clientCount: () => clients.size,
  };
}

module.exports = { createHub };
