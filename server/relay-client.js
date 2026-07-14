// Desktop side of the cloud relay. It dials *out* to the relay — which is the
// point: a desktop behind NAT can't be dialled, but it can hold one outbound
// socket, and every phone in its room rides that socket.
//
// Two multiplexes arrive on it (see relay-frames.js):
//
//   {c, …}  a phone. Each becomes a hub client, so a relayed phone runs the
//           exact same hello → pair/auth → ready machine as a LAN one, against
//           the same device store — and one hub.broadcast() reaches both.
//   {h, …}  a byte stream for a forwarded dev server. It is piped into the
//           desktop's own http-proxy listener on 127.0.0.1, so http-proxy.js
//           handles the HTTP, the auth cookie and the HMR upgrade exactly as it
//           does for a LAN phone. This side moves bytes and nothing else.

const WebSocket = require('ws');
const net = require('net');
const F = require('./relay-frames');

const MAX_BACKOFF_MS = 30000;

// https://host → wss://host/?role=desktop&room=<id> (http → ws, for tests).
function relayWsUrl(relayUrl, room) {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/';
  u.search = `role=desktop&room=${encodeURIComponent(room)}`;
  return u.toString();
}

// opts: { relayUrl, room, hub, tunnel: { localPort(targetPort) → Promise<port> }, log }
// Returns { url, connected(), close() }. Reconnects with backoff until closed.
function startRelayClient({ relayUrl, room, hub, tunnel, log = () => {} }) {
  const url = relayWsUrl(relayUrl, room);
  const clients = new Map(); // clientId -> hub client
  const streams = new Map(); // streamId -> { socket, queue, connecting }
  let ws = null;
  let retry = 0;
  let timer = null;
  let closed = false;

  const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  function dropClients() {
    for (const c of clients.values()) c.close();
    clients.clear();
  }
  function dropStreams() {
    for (const s of streams.values()) if (s.socket) s.socket.destroy();
    streams.clear();
  }

  function onClientFrame(msg) {
    if (msg.gone) {
      const c = clients.get(msg.c);
      clients.delete(msg.c);
      // Same as a LAN socket dying: the hub hands whatever it held back.
      if (c) c.close();
      return;
    }
    if (msg.joined) {
      // Greet it. A re-announced phone gets a second hello and re-auths over the
      // socket it already has, so replace any stale client rather than keeping it.
      clients.get(msg.c)?.close();
      clients.set(msg.c, hub.connect((out) => send(F.clientFrame(msg.c, out)), 'relay'));
      return;
    }
    clients.get(msg.c)?.handle(JSON.stringify(msg.d));
  }

  // A forwarded-port stream. The relay sends `open` immediately followed by the
  // request head, so bytes land before the local socket is up — queue them.
  function onTunnelFrame(msg) {
    const id = msg.h;
    if (msg.t === 'open') {
      const s = { socket: null, queue: [], ended: false };
      streams.set(id, s);
      Promise.resolve(tunnel.localPort(msg.port)).then((localPort) => {
        if (!streams.has(id)) return;
        const socket = net.connect(localPort, '127.0.0.1', () => {
          for (const b of s.queue) socket.write(b);
          s.queue = [];
          if (s.ended) socket.end();
        });
        s.socket = socket;
        socket.on('data', (b) => send(F.tunnelData(id, b)));
        socket.on('end', () => send(F.tunnelEnd(id)));
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
          if (streams.delete(id)) send(F.tunnelClose(id));
        });
      }).catch((err) => {
        streams.delete(id);
        send(F.tunnelClose(id, String((err && err.message) || err)));
      });
      return;
    }

    const s = streams.get(id);
    if (!s) return;
    if (msg.t === 'data') {
      const bytes = F.tunnelBytes(msg);
      if (s.socket) s.socket.write(bytes); else s.queue.push(bytes);
      return;
    }
    if (msg.t === 'end') {
      if (s.socket) s.socket.end(); else s.ended = true;
      return;
    }
    if (msg.t === 'close') {
      streams.delete(id);
      if (s.socket) s.socket.destroy();
    }
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(url);

    ws.on('open', () => { retry = 0; log(`[relay] connected to ${url}`); });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (F.isTunnelFrame(msg)) return onTunnelFrame(msg);
      if (F.isClientFrame(msg)) return onClientFrame(msg);
    });
    // A dead relay socket means every phone behind it is unreachable, whether or
    // not its own socket is still open — so let them go and let the hub release
    // whatever they held (a session's PTY, say). They come back on reconnect.
    ws.on('close', () => {
      dropClients();
      dropStreams();
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retry++, MAX_BACKOFF_MS);
      timer = setTimeout(connect, delay);
      timer.unref?.();
    });
    ws.on('error', (err) => log(`[relay] ${err.message}`));
  }

  connect();

  return {
    url,
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
    close() {
      closed = true;
      clearTimeout(timer);
      dropClients();
      dropStreams();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { startRelayClient, relayWsUrl, MAX_BACKOFF_MS };
