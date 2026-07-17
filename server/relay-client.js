// Desktop side of the cloud relay. It dials *out* to the relay — which is the
// point: a desktop behind NAT can't be dialled, but it can hold one outbound
// socket, and every phone in its room rides that socket.
//
// Two multiplexes arrive on it (see relay-frames.js):
//
//   {c, …}  a phone. Each becomes a hub client, running the hello → pair/auth →
//           ready machine against the device store — one hub.broadcast() reaches
//           every phone in the room.
//   {h, …}  a byte stream for a forwarded dev server. It is piped into the
//           desktop's own http-proxy listener on 127.0.0.1, so http-proxy.js
//           handles the HTTP, the auth cookie and the HMR upgrade exactly as it
//           does for a LAN phone. This side moves bytes and nothing else.

const WebSocket = require('ws');
const net = require('net');
const F = require('./relay-frames');
const { debugFor } = require('./debug');

const debug = debugFor('client');
const debugTunnel = debugFor('tunnel');

const MAX_BACKOFF_MS = 30000;
// Pre-connect buffer bound per stream: bytes arrive before the local socket is up and
// are queued, so a large upload against a slow-to-bind dev server would grow this
// without limit. Past the cap the stream is aborted rather than buffered forever.
const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

// https://host → wss://host/?role=desktop&room=<id>&instance=<id> (http → ws, for
// tests). The room is the machine; the instance is this window. Siblings share the
// room, so without the instance id the relay could not tell them apart — and would
// have to treat the second one as the first reconnecting, and evict it.
function relayWsUrl(relayUrl, room, instance) {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = '/';
  u.search = `role=desktop&room=${encodeURIComponent(room)}`;
  if (instance) u.search += `&instance=${encodeURIComponent(instance)}`;
  return u.toString();
}

// opts: { relayUrl, room, instance, hub, tunnel: { localPort(targetPort) → Promise<port> }, log }
// Returns { url, connected(), close() }. Reconnects with backoff until closed.
function startRelayClient({ relayUrl, room, instance, hub, tunnel, log = () => {} }) {
  const url = relayWsUrl(relayUrl, room, instance);
  const clients = new Map(); // clientId -> hub client
  const streams = new Map(); // streamId -> { socket, queue, connecting }
  let ws = null;
  let retry = 0;
  let timer = null;
  let closed = false;

  const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  function dropClients() {
    if (clients.size) debug('dropping clients', { clients: clients.size });
    for (const c of clients.values()) c.close();
    clients.clear();
  }
  function dropStreams() {
    if (streams.size) debugTunnel('dropping streams', { streams: streams.size });
    for (const s of streams.values()) if (s.socket) s.socket.destroy();
    streams.clear();
  }

  function onClientFrame(msg) {
    if (msg.gone) {
      const c = clients.get(msg.c);
      clients.delete(msg.c);
      debug('client gone', { client: msg.c, clients: clients.size });
      // Same as a LAN socket dying: the hub hands whatever it held back.
      if (c) c.close();
      return;
    }
    if (msg.joined) {
      // Greet it. A re-announced phone gets a second hello and re-auths over the
      // socket it already has, so replace any stale client rather than keeping it.
      const stale = clients.get(msg.c);
      stale?.close();
      clients.set(msg.c, hub.connect((out) => {
        debug('→ client', { client: msg.c, t: out.t, ch: out.ch, id: out.id });
        send(F.clientFrame(msg.c, out));
      }));
      debug('client joined', { client: msg.c, clients: clients.size, replaced: !!stale });
      return;
    }
    debug('← client', { client: msg.c, t: msg.d && msg.d.t, ch: msg.d && msg.d.ch, id: msg.d && msg.d.id });
    clients.get(msg.c)?.handle(JSON.stringify(msg.d));
  }

  // A forwarded-port stream. The relay sends `open` immediately followed by the
  // request head, so bytes land before the local socket is up — queue them.
  function onTunnelFrame(msg) {
    const id = msg.h;
    if (msg.t === 'open') {
      // No tunnel injected means port forwarding is parked (see remote.js): a
      // stale /p/ URL in a phone's browser must fail cleanly, not crash us.
      if (!tunnel) {
        debugTunnel('open refused', { stream: id, port: msg.port, reason: 'forwarding-disabled' });
        send(F.tunnelClose(id, 'forwarding-disabled'));
        return;
      }
      const s = { socket: null, queue: [], queuedBytes: 0, ended: false };
      streams.set(id, s);
      debugTunnel('open', { stream: id, port: msg.port, streams: streams.size });
      Promise.resolve(tunnel.localPort(msg.port)).then((localPort) => {
        if (!streams.has(id)) {
          debugTunnel('open abandoned', { stream: id, port: msg.port, reason: 'closed-while-starting' });
          return;
        }
        const socket = net.connect(localPort, '127.0.0.1', () => {
          debugTunnel('local connected', { stream: id, localPort, queued: s.queue.length });
          for (const b of s.queue) socket.write(b);
          s.queue = [];
          if (s.ended) socket.end();
        });
        s.socket = socket;
        socket.on('data', (b) => {
          debugTunnel('local → relay', { stream: id, bytes: b.length });
          send(F.tunnelData(id, b));
        });
        socket.on('end', () => {
          debugTunnel('local ended', { stream: id });
          send(F.tunnelEnd(id));
        });
        socket.on('error', (err) => {
          debugTunnel('local error', { stream: id, error: err.message });
          socket.destroy();
        });
        socket.on('close', () => {
          if (streams.delete(id)) {
            debugTunnel('local closed', { stream: id, streams: streams.size });
            send(F.tunnelClose(id));
          }
        });
      }).catch((err) => {
        const error = String((err && err.message) || err);
        debugTunnel('open failed', { stream: id, port: msg.port, error });
        streams.delete(id);
        send(F.tunnelClose(id, error));
      });
      return;
    }

    const s = streams.get(id);
    if (!s) {
      debugTunnel('frame dropped', { stream: id, t: msg.t, reason: 'unknown-stream' });
      return;
    }
    if (msg.t === 'data') {
      const bytes = F.tunnelBytes(msg);
      debugTunnel('relay → local', { stream: id, bytes: bytes.length, queued: !s.socket });
      if (s.socket) { s.socket.write(bytes); return; }
      s.queue.push(bytes);
      s.queuedBytes += bytes.length;
      if (s.queuedBytes > QUEUE_MAX_BYTES) {
        debugTunnel('stream aborted', { stream: id, queuedBytes: s.queuedBytes, reason: 'queue-overflow' });
        streams.delete(id);
        send(F.tunnelClose(id, 'queue overflow'));
      }
      return;
    }
    if (msg.t === 'end') {
      debugTunnel('relay ended stream', { stream: id });
      if (s.socket) s.socket.end(); else s.ended = true;
      return;
    }
    if (msg.t === 'close') {
      debugTunnel('relay closed stream', { stream: id, error: msg.error });
      streams.delete(id);
      if (s.socket) s.socket.destroy();
    }
  }

  function connect() {
    if (closed) return;
    debug('dialing', { url, room, instance, attempt: retry });
    ws = new WebSocket(url);

    ws.on('open', () => {
      retry = 0;
      debug('connected', { url });
      log(`[relay] connected to ${url}`);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch {
        debug('frame dropped', { reason: 'bad-json' });
        return;
      }
      if (F.isTunnelFrame(msg)) return onTunnelFrame(msg);
      if (F.isClientFrame(msg)) return onClientFrame(msg);
      debug('frame ignored', { reason: 'unknown-shape' });
    });
    // A dead relay socket means every phone behind it is unreachable, whether or
    // not its own socket is still open — so let them go and let the hub release
    // whatever they held (a session's PTY, say). They come back on reconnect.
    ws.on('close', (code) => {
      debug('disconnected', { code, clients: clients.size, streams: streams.size });
      dropClients();
      dropStreams();
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retry++, MAX_BACKOFF_MS);
      debug('reconnecting', { delayMs: delay, attempt: retry });
      timer = setTimeout(connect, delay);
      timer.unref?.();
    });
    ws.on('error', (err) => {
      debug('socket error', { error: err.message });
      log(`[relay] ${err.message}`);
    });
  }

  connect();

  return {
    url,
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
    close() {
      debug('closing', { clients: clients.size, streams: streams.size });
      closed = true;
      clearTimeout(timer);
      dropClients();
      dropStreams();
      if (ws) ws.terminate();
    },
  };
}

module.exports = { startRelayClient, relayWsUrl, MAX_BACKOFF_MS };
