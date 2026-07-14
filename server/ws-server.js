// LAN WebSocket server bridging remote clients to the desktop's IPC handlers.
// Electron-free: the embedder injects `invoke(kind, ch, args, ctx)` (calls the
// registered IPC handler) and a device store; this file only owns sockets and
// the hello → pair/auth → ready state machine. The same protocol can later be
// served by a cloud relay because messages are opaque envelopes.

const { WebSocketServer } = require('ws');
const proto = require('./protocol');
const auth = require('./auth-lib');

const HEARTBEAT_MS = 15000;

// opts: { port (0 = ephemeral), host, invoke, deviceStore, appVersion }
// Returns { port, close, broadcast, pairing, clientCount }.
function startRemoteServer(opts) {
  const { invoke, deviceStore, appVersion = '' } = opts;
  const pairing = opts.pairing || auth.createPairingState();
  const wss = new WebSocketServer({ port: opts.port || 0, host: opts.host || '0.0.0.0' });
  const clients = new Set(); // authed sockets

  wss.on('connection', (ws) => {
    let deviceId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    send(proto.hello());

    ws.on('message', async (raw) => {
      const msg = proto.parseMessage(raw.toString());
      if (!msg) return send(proto.authErr(proto.ERR.BAD_MESSAGE));

      if (msg.t === 'pair') {
        if (!pairing.consume(msg.pairToken)) return send(proto.authErr(proto.ERR.BAD_TOKEN));
        const { device, token } = auth.createDevice(deviceStore, msg.deviceName);
        deviceId = ws.deviceId = device.id;
        clients.add(ws);
        return send(proto.paired(token, device.id));
      }
      if (msg.t === 'auth') {
        const device = auth.verifyDevice(deviceStore, msg.deviceToken);
        if (!device) return send(proto.authErr(proto.ERR.BAD_TOKEN));
        deviceId = ws.deviceId = device.id;
        clients.add(ws);
        return send(proto.authOk(device.id, appVersion));
      }

      if (!deviceId) return send(proto.authErr(proto.ERR.NOT_AUTHED));

      if (msg.t === 'req') {
        if (!proto.canCall('req', msg.ch)) return send(proto.resErr(msg.id, proto.ERR.CHANNEL_DENIED));
        try {
          const result = await invoke('req', msg.ch, msg.args, { deviceId });
          send(proto.resOk(msg.id, result));
        } catch (err) {
          send(proto.resErr(msg.id, String((err && err.message) || err)));
        }
        return;
      }
      if (msg.t === 'send') {
        if (!proto.canCall('send', msg.ch)) return;
        try { invoke('send', msg.ch, msg.args, { deviceId }); } catch {}
        return;
      }

      // Port forwarding (Phase 3): the embedder injects `forward` with
      // open(port) → url and close(port); without it the feature is off
      // (e.g. a bare relay deployment).
      if (msg.t === 'fwd-open') {
        if (!opts.forward) return send(proto.fwdErr(msg.port, 'forwarding-disabled'));
        try {
          send(proto.fwdOk(msg.port, await opts.forward.open(msg.port)));
        } catch (err) {
          send(proto.fwdErr(msg.port, String((err && err.message) || err)));
        }
        return;
      }
      if (msg.t === 'fwd-close') {
        if (opts.forward) { try { await opts.forward.close(msg.port); } catch {} }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      // A device that vanishes (locked phone, dropped Wi-Fi) can't clean up whatever
      // it was holding, so tell the embedder which one left.
      if (deviceId && opts.onDisconnect) {
        // Only when it's really gone: the same device may hold another live socket.
        const stillHere = [...clients].some((c) => c.deviceId === deviceId);
        if (!stillHere) { try { opts.onDisconnect(deviceId); } catch {} }
      }
    });
  });

  // Drop sockets that stop answering pings (phone locked, Wi-Fi dropped).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  function broadcast(ch, payload) {
    if (!proto.isRemoteEvent(ch) || clients.size === 0) return;
    const frame = JSON.stringify(proto.ev(ch, payload));
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(frame);
  }

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => resolve({
      port: wss.address().port,
      pairing,
      broadcast,
      clientCount: () => clients.size,
      close: () => new Promise((res) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => res());
      }),
    }));
  });
}

module.exports = { startRemoteServer, HEARTBEAT_MS };
