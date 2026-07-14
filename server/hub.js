// The remote-client state machine, with no socket under it. One hub owns the
// pairing state, the set of authed clients and the broadcast fan-out; a client
// is just a `send` function plus the frames it hands back, so the same machine
// serves a LAN WebSocket (ws-server.js) and a client arriving down the cloud
// relay (relay-client.js) — and one broadcast reaches both.
//
// The transports differ in one way the handlers care about: a phone on the LAN
// can open a proxied dev-server URL directly, a phone behind the relay cannot.
// So each client carries a `via` ('lan' | 'relay') and forward.open() gets it.

const proto = require('./protocol');
const auth = require('./auth-lib');

// opts: { invoke, deviceStore, appVersion, forward, onDisconnect, pairing }
function createHub(opts) {
  const { invoke, deviceStore, appVersion = '' } = opts;
  const pairing = opts.pairing || auth.createPairingState();
  const clients = new Set(); // authed clients, LAN and relay alike

  // Connect a transport. `send` takes a message object; `via` says which
  // transport it arrived on. Returns the client: feed it raw frames, close it
  // when the socket dies.
  function connect(send, via = 'lan') {
    const client = { deviceId: null, via, send, open: true };

    const reply = (msg) => { if (client.open) send(msg); };
    reply(proto.hello());

    async function handle(raw) {
      const msg = proto.parseMessage(String(raw));
      if (!msg) return reply(proto.authErr(proto.ERR.BAD_MESSAGE));

      if (msg.t === 'pair') {
        if (!pairing.consume(msg.pairToken)) return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        const { device, token } = auth.createDevice(deviceStore, msg.deviceName);
        client.deviceId = device.id;
        clients.add(client);
        return reply(proto.paired(token, device.id));
      }
      if (msg.t === 'auth') {
        const device = auth.verifyDevice(deviceStore, msg.deviceToken);
        if (!device) return reply(proto.authErr(proto.ERR.BAD_TOKEN));
        client.deviceId = device.id;
        clients.add(client);
        return reply(proto.authOk(device.id, appVersion));
      }

      if (!client.deviceId) return reply(proto.authErr(proto.ERR.NOT_AUTHED));
      const ctx = { deviceId: client.deviceId, via };

      if (msg.t === 'req') {
        if (!proto.canCall('req', msg.ch)) return reply(proto.resErr(msg.id, proto.ERR.CHANNEL_DENIED));
        try {
          reply(proto.resOk(msg.id, await invoke('req', msg.ch, msg.args, ctx)));
        } catch (err) {
          reply(proto.resErr(msg.id, String((err && err.message) || err)));
        }
        return;
      }
      if (msg.t === 'send') {
        if (!proto.canCall('send', msg.ch)) return;
        try { invoke('send', msg.ch, msg.args, ctx); } catch {}
        return;
      }

      // Port forwarding: the embedder injects `forward`; without it the feature
      // is off. open() gets `via` because the URL a LAN phone can reach and the
      // one a relayed phone can reach are different addresses.
      if (msg.t === 'fwd-open') {
        if (!opts.forward) return reply(proto.fwdErr(msg.port, 'forwarding-disabled'));
        try {
          reply(proto.fwdOk(msg.port, await opts.forward.open(msg.port, ctx)));
        } catch (err) {
          reply(proto.fwdErr(msg.port, String((err && err.message) || err)));
        }
        return;
      }
      if (msg.t === 'fwd-close') {
        if (opts.forward) { try { await opts.forward.close(msg.port, ctx); } catch {} }
      }
    }

    function close() {
      if (!client.open) return;
      client.open = false;
      clients.delete(client);
      // A device that vanishes (locked phone, dropped Wi-Fi) can't release what it
      // was holding, so tell the embedder which one left — but only once it's
      // really gone: the same device may hold another live socket, on either
      // transport (a phone roaming off Wi-Fi reconnects over the relay).
      if (client.deviceId && opts.onDisconnect) {
        const stillHere = [...clients].some((c) => c.deviceId === client.deviceId);
        if (!stillHere) { try { opts.onDisconnect(client.deviceId); } catch {} }
      }
    }

    return { handle, close, get deviceId() { return client.deviceId; } };
  }

  function broadcast(ch, payload) {
    if (!proto.isRemoteEvent(ch) || clients.size === 0) return;
    const msg = proto.ev(ch, payload);
    for (const c of clients) c.send(msg);
  }

  return {
    connect,
    broadcast,
    pairing,
    clientCount: () => clients.size,
    clientCountVia: (via) => [...clients].filter((c) => c.via === via).length,
  };
}

module.exports = { createHub };
