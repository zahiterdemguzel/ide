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

// opts: { invoke, deviceStore, appVersion, forward, onDisconnect, onClientsChanged, pairing }
function createHub(opts) {
  const { invoke, deviceStore, appVersion = '' } = opts;
  const pairing = opts.pairing || auth.createPairingState();
  const clients = new Set(); // authed clients
  const notifyClients = () => { if (opts.onClientsChanged) { try { opts.onClientsChanged(clients.size); } catch {} } };

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
        // One socket carries one identity for its whole life. An already-identified
        // client that re-pairs would swap `client.deviceId` to a fresh device, and
        // `close()` would then release only the new one — stranding whatever the old
        // identity held (session control, PTY claim) forever.
        if (client.deviceId) {
          trace('pair rejected', { reason: 'already-identified', device: client.deviceId });
          return reply(proto.authErr(proto.ERR.BAD_MESSAGE));
        }
        if (!pairing.consume(msg.pairToken)) {
          trace('pair rejected', { reason: proto.ERR.BAD_TOKEN });
          return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        }
        const { device, token } = auth.createDevice(deviceStore, msg.deviceName);
        client.deviceId = device.id;
        clients.add(client);
        notifyClients();
        trace('paired', { device: device.id, name: device.name, clients: clients.size });
        return reply(proto.paired(token, device.id));
      }
      if (msg.t === 'auth') {
        const device = auth.verifyDevice(deviceStore, msg.deviceToken);
        if (!device) {
          trace('auth rejected', { reason: proto.ERR.BAD_TOKEN });
          return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        }
        // Re-auth on the same socket is legitimate — a desktop restart re-announces its
        // phones with a fresh `hello` and they re-auth without reconnecting — but only
        // to the SAME identity. A token resolving to a different device on an already
        // identified socket is an identity swap; refuse it (see the pair note above).
        if (client.deviceId && client.deviceId !== device.id) {
          trace('auth rejected', { reason: 'identity-swap', from: client.deviceId, to: device.id });
          return reply(proto.authErr(proto.ERR.BAD_MESSAGE));
        }
        client.deviceId = device.id;
        clients.add(client);
        notifyClients();
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
        // `invoke` may return a promise; a `send` channel is fire-and-forget so it's
        // not awaited, but an unhandled rejection can crash the process under strict
        // mode — catch both the synchronous throw and the async rejection.
        try {
          Promise.resolve(invoke('send', msg.ch, msg.args, ctx)).catch((err) => {
            trace('send failed', { ch: msg.ch, error: String((err && err.message) || err) });
          });
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
      if (clients.delete(client)) notifyClients();
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
    // The hub is transport-agnostic: one client's `send` throwing (a dead or
    // backpressured socket in some transport) must not skip every client after it in
    // the Set, nor propagate out of whatever emitted the event.
    for (const c of clients) { try { c.send(msg); } catch (err) { debug('broadcast send failed', { ch, error: String((err && err.message) || err) }); } }
  }

  return {
    connect,
    broadcast,
    pairing,
    clientCount: () => clients.size,
  };
}

module.exports = { createHub };
