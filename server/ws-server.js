// LAN WebSocket server for remote clients. It owns sockets and nothing else:
// the hello → pair/auth → ready machine, the allowlist and the device store all
// live in hub.js, so a client dialling in over the cloud relay runs the exact
// same code (see relay-client.js). The embedder passes one hub to both.

const { WebSocketServer } = require('ws');
const { createHub } = require('./hub');

const HEARTBEAT_MS = 15000;

// opts: { port (0 = ephemeral), host, hub } or, without a hub, the hub's own
// opts ({ invoke, deviceStore, appVersion, forward, onDisconnect }) and one is
// built here. Returns { port, hub, pairing, broadcast, clientCount, close }.
function startRemoteServer(opts) {
  const hub = opts.hub || createHub(opts);
  const wss = new WebSocketServer({ port: opts.port || 0, host: opts.host || '0.0.0.0' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const client = hub.connect((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    }, 'lan');
    ws.on('message', (raw) => client.handle(raw.toString()));
    ws.on('close', () => client.close());
  });

  // Drop sockets that stop answering pings (phone locked, Wi-Fi dropped).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => resolve({
      port: wss.address().port,
      hub,
      pairing: hub.pairing,
      broadcast: hub.broadcast,
      clientCount: hub.clientCount,
      close: () => new Promise((res) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => res());
      }),
    }));
  });
}

module.exports = { startRemoteServer, HEARTBEAT_MS };
