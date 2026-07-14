// Standalone cloud relay: bridges sockets between a desktop app and its mobile
// clients when they are not on the same LAN. Deliberately logic-free — it never
// parses IDE protocol frames; pair/auth/req/res/ev messages pass through
// verbatim and are verified end-to-end by the desktop. Rooms are keyed by an id
// the desktop generates and persists; a mobile client learns it from the QR code.
//
//   desktop:  ws://relay/?role=desktop&room=<id>&instance=<id>
//   mobile:   ws://relay/?role=mobile&room=<id>[&instance=<id>]
//
// A room is a *machine*, not a window: the desktop app runs many instances side by
// side and a phone pairs with the machine once, so several desktops share one room
// and each is addressed by its instance id. A phone names the instance it wants to
// drive; one that names none (its first dial, before it has ever seen the list) gets
// the newest, and asks that one for the roster over the authed `list-instances`
// channel. The relay itself never learns which project a window has open — the roster
// is served by the desktop, behind auth, and never passes through here.
//
// It also carries the phone's *browser* to a dev server forwarded on the desktop
// (the Ports tab), which a phone off the LAN cannot reach. That traffic is plain
// HTTP arriving on this same port, and it is spliced raw — byte for byte — down
// the desktop's websocket into the desktop's own http-proxy listener. So the
// relay speaks no HTTP to the desktop and reimplements none of that proxy's
// auth, cookie-swap or HMR-upgrade handling. relay-route.js tells the kinds of
// traffic apart; relay-frames.js is the whole envelope vocabulary.

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { HEALTH_PATH } = require('./keepalive');
const { parseHead, route, MAX_HEAD, DEFAULT_INSTANCE } = require('./relay-route');
const F = require('./relay-frames');
const { debugFor } = require('./debug');

const debug = debugFor('relay');
const debugRoute = debugFor('route');
const debugTunnel = debugFor('tunnel');

const HEAD_END = Buffer.from('\r\n\r\n');

function startRelay({ port, host = '0.0.0.0' } = {}) {
  // roomId -> { desktops: Map<instanceId, ws>, latest: instanceId|null,
  //             clients: Map<clientId, { ws, instance }>,
  //             streams: Map<streamId, { socket, instance }> }
  const rooms = new Map();
  let nextStream = 1;

  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { desktops: new Map(), latest: null, clients: new Map(), streams: new Map() });
    return rooms.get(id);
  };
  const alive = (ws) => !!ws && ws.readyState === ws.OPEN;
  const toDesktop = (r, instance, msg) => {
    const ws = r.desktops.get(instance);
    if (alive(ws)) ws.send(JSON.stringify(msg));
  };

  // The relay's own HTTP surface: the health check the keep-alive ping hits, and
  // the websocket upgrades carrying the IDE protocol. It never binds a port — the
  // demuxer below owns the port and hands it only the connections that are its.
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url.split('?')[0] === HEALTH_PATH) {
      debug('health', { rooms: rooms.size });
      res.end(`ide-relay ok rooms=${rooms.size}\n`);
      return;
    }
    res.end('ide-relay ok\n');
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://relay');
    const role = url.searchParams.get('role');
    const roomId = url.searchParams.get('room');
    if (!roomId || (role !== 'desktop' && role !== 'mobile')) {
      debug('ws rejected', { role, room: roomId, reason: 'bad-params' });
      return ws.close(4000, 'bad params');
    }
    const r = room(roomId);

    if (role === 'desktop') {
      // A desktop from before instances existed sends no id; it is the room's only
      // window, so give it the same fixed one a phone falls back to.
      const instance = url.searchParams.get('instance') || DEFAULT_INSTANCE;
      // Same window dialling back in (its socket dropped and it reconnected) — drop
      // the stale one. A *sibling* window has a different id and is left alone: that
      // is the whole point of keying by instance.
      const prev = r.desktops.get(instance);
      if (prev) {
        debug('desktop replaced', { room: roomId, instance });
        prev.close(4001, 'replaced');
      }
      r.desktops.set(instance, ws);
      r.latest = instance;
      debug('desktop joined', { room: roomId, instance, desktops: r.desktops.size, waiting: r.clients.size });
      // A desktop that restarts finds phones already holding sockets here. They
      // are waiting on a `hello` only the desktop can send, so re-announce the ones
      // bound to it: it greets each, and they re-auth without reconnecting. This is
      // also what lets a phone name a window that has not dialled in yet — it waits,
      // and is announced the moment that window arrives.
      for (const [id, c] of r.clients) {
        if (c.instance === instance) {
          debug('re-announce client', { room: roomId, instance, client: id });
          toDesktop(r, instance, F.clientJoined(id));
        }
      }
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch {
          debug('desktop frame dropped', { room: roomId, instance, reason: 'bad-json' });
          return;
        }
        if (F.isTunnelFrame(msg)) return fromDesktopTunnel(r, msg);
        if (!F.isClientFrame(msg)) return;
        // Route {c, d} back to the addressed client; d is opaque. Only to a client
        // that is actually bound to this window — a desktop must not be able to
        // reach a phone driving its sibling.
        const c = r.clients.get(msg.c);
        if (c && c.instance === instance && alive(c.ws)) {
          debug('desktop → client', { room: roomId, instance, client: msg.c, t: msg.d && msg.d.t, ch: msg.d && msg.d.ch });
          c.ws.send(JSON.stringify(msg.d));
          return;
        }
        debug('desktop → client dropped', { room: roomId, instance, client: msg.c, reason: c ? 'not-bound-or-dead' : 'unknown-client' });
      });
      ws.on('close', () => {
        if (r.desktops.get(instance) !== ws) return; // a reconnect already replaced us
        r.desktops.delete(instance);
        if (r.latest === instance) r.latest = [...r.desktops.keys()].pop() || null;
        debug('desktop left', { room: roomId, instance, desktops: r.desktops.size });
        for (const [id, c] of r.clients) {
          if (c.instance !== instance) continue;
          r.clients.delete(id);
          debug('client evicted', { room: roomId, instance, client: id, reason: 'desktop-gone' });
          c.ws.close(4002, 'desktop gone');
        }
        for (const [id, s] of r.streams) {
          if (s.instance !== instance) continue;
          r.streams.delete(id);
          debugTunnel('stream destroyed', { room: roomId, instance, stream: id, reason: 'desktop-gone' });
          s.socket.destroy();
        }
        // Siblings may still be serving this machine's phones — the room outlives
        // any one window, and is only gone when the last one is.
        if (r.desktops.size === 0) {
          rooms.delete(roomId);
          debug('room closed', { room: roomId, rooms: rooms.size });
        }
      });
      return;
    }

    // The window this phone wants. It may name one it saw in the roster, or none at
    // all on its very first dial — before it has ever fetched a roster there is
    // nothing to name, so hand it the newest window and let it list from there.
    const instance = url.searchParams.get('instance') || r.latest || DEFAULT_INSTANCE;
    const clientId = crypto.randomUUID();
    r.clients.set(clientId, { ws, instance });
    debug('client joined', {
      room: roomId, instance, client: clientId, clients: r.clients.size, desktopHere: r.desktops.has(instance),
    });
    toDesktop(r, instance, F.clientJoined(clientId));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch {
        debug('client frame dropped', { room: roomId, client: clientId, reason: 'bad-json' });
        return;
      }
      debug('client → desktop', { room: roomId, instance, client: clientId, t: frame.t, ch: frame.ch, id: frame.id });
      toDesktop(r, instance, F.clientFrame(clientId, frame));
    });
    ws.on('close', () => {
      r.clients.delete(clientId);
      debug('client left', { room: roomId, instance, client: clientId, clients: r.clients.size });
      toDesktop(r, instance, F.clientGone(clientId));
    });
  });

  // Bytes coming back up a forwarded-port stream.
  function fromDesktopTunnel(r, msg) {
    const s = r.streams.get(msg.h);
    if (!s) {
      debugTunnel('upstream frame dropped', { stream: msg.h, t: msg.t, reason: 'unknown-stream' });
      return;
    }
    if (msg.t === 'data') {
      const bytes = F.tunnelBytes(msg);
      debugTunnel('desktop → browser', { stream: msg.h, bytes: bytes.length });
      return void s.socket.write(bytes);
    }
    if (msg.t === 'end') {
      debugTunnel('desktop ended stream', { stream: msg.h });
      return void s.socket.end();
    }
    if (msg.t === 'close') {
      debugTunnel('desktop closed stream', { stream: msg.h, error: msg.error });
      r.streams.delete(msg.h);
      s.socket.destroy();
    }
  }

  const reply = (socket, status, body, headers = {}) => {
    const lines = [`HTTP/1.1 ${status}`, 'connection: close', `content-length: ${Buffer.byteLength(body)}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
  };

  // One public port, four kinds of caller. Read just the request head, decide,
  // then either hand the whole connection (head included) back to the HTTP
  // server or splice it to a desktop.
  const demuxer = net.createServer((socket) => {
    let head = Buffer.alloc(0);

    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEAD_END);
      if (end === -1) {
        if (head.length > MAX_HEAD) socket.destroy();
        return;
      }
      socket.removeListener('data', onData);
      socket.pause();

      const parsed = parseHead(head.subarray(0, end).toString('latin1'));
      const decision = parsed ? route(parsed) : { kind: 'deny' };
      debugRoute(decision.kind, {
        method: parsed && parsed.method,
        target: parsed && parsed.target,
        room: decision.room,
        instance: decision.instance,
        port: decision.port,
      });

      if (decision.kind === 'ws' || decision.kind === 'health') {
        // Put the head back and let the HTTP server parse this connection as if
        // it had arrived there directly.
        socket.unshift(head);
        httpServer.emit('connection', socket);
        socket.resume();
        return;
      }
      if (decision.kind === 'entry') {
        return reply(socket, '302 Found', '', { location: decision.location, 'set-cookie': decision.setCookie });
      }
      if (decision.kind !== 'tunnel') {
        return reply(socket, '403 Forbidden', 'Forbidden.\n');
      }

      // The URL names the window as well as the port, because two windows on one
      // machine can each be proxying the same dev-server port and only the one that
      // minted the auth token will accept it.
      const r = rooms.get(decision.room);
      const desktop = r && r.desktops.get(decision.instance);
      if (!alive(desktop)) {
        debugTunnel('open refused', { room: decision.room, instance: decision.instance, port: decision.port, reason: 'desktop-offline' });
        return reply(socket, '502 Bad Gateway', 'That desktop is offline. Open the IDE and try again.\n');
      }

      // Splice. From here the connection is opaque bytes in both directions —
      // including the websocket upgrade a dev server's HMR client will make.
      const id = nextStream++;
      r.streams.set(id, { socket, instance: decision.instance });
      debugTunnel('open', { stream: id, room: decision.room, instance: decision.instance, port: decision.port, head: head.length });
      toDesktop(r, decision.instance, F.tunnelOpen(id, decision.port));
      toDesktop(r, decision.instance, F.tunnelData(id, head)); // the head we read is part of the stream

      socket.on('data', (b) => {
        debugTunnel('browser → desktop', { stream: id, bytes: b.length });
        toDesktop(r, decision.instance, F.tunnelData(id, b));
      });
      socket.on('end', () => {
        debugTunnel('browser ended stream', { stream: id });
        toDesktop(r, decision.instance, F.tunnelEnd(id));
      });
      socket.on('close', () => {
        if (r.streams.delete(id)) {
          debugTunnel('browser closed stream', { stream: id });
          toDesktop(r, decision.instance, F.tunnelClose(id));
        }
      });
      socket.resume();
    };

    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    demuxer.on('error', reject);
    demuxer.listen(port, host, () => {
      debug('listening', { port: demuxer.address().port, host });
      resolve({
        port: demuxer.address().port,
        close: () => new Promise((res) => {
          debug('shutting down', { rooms: rooms.size });
          for (const c of wss.clients) c.terminate();
          for (const r of rooms.values()) for (const s of r.streams.values()) s.socket.destroy();
          rooms.clear();
          demuxer.close(() => res());
        }),
      });
    });
  });
}

module.exports = { startRelay };
