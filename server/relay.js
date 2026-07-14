// Standalone cloud relay: bridges sockets between a desktop app and its mobile
// clients when they are not on the same LAN. Deliberately logic-free — it never
// parses IDE protocol frames; pair/auth/req/res/ev messages pass through
// verbatim and are verified end-to-end by the desktop. Rooms are keyed by an id
// the desktop generates and persists; a mobile client learns it from the QR code.
//
//   desktop:  ws://relay/?role=desktop&room=<id>
//   mobile:   ws://relay/?role=mobile&room=<id>
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
const { parseHead, route, MAX_HEAD } = require('./relay-route');
const F = require('./relay-frames');

const HEAD_END = Buffer.from('\r\n\r\n');

function startRelay({ port, host = '0.0.0.0' } = {}) {
  const rooms = new Map(); // roomId -> { desktop: ws|null, clients: Map<clientId, ws>, streams: Map<streamId, socket> }
  let nextStream = 1;

  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { desktop: null, clients: new Map(), streams: new Map() });
    return rooms.get(id);
  };
  const alive = (ws) => !!ws && ws.readyState === ws.OPEN;
  const toDesktop = (r, msg) => { if (alive(r.desktop)) r.desktop.send(JSON.stringify(msg)); };

  // The relay's own HTTP surface: the health check the keep-alive ping hits, and
  // the websocket upgrades carrying the IDE protocol. It never binds a port — the
  // demuxer below owns the port and hands it only the connections that are its.
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url.split('?')[0] === HEALTH_PATH) {
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
    if (!roomId || (role !== 'desktop' && role !== 'mobile')) return ws.close(4000, 'bad params');
    const r = room(roomId);

    if (role === 'desktop') {
      if (r.desktop) r.desktop.close(4001, 'replaced');
      r.desktop = ws;
      // A desktop that restarts finds phones already holding sockets here. They
      // are waiting on a `hello` only the desktop can send, so re-announce them:
      // the new desktop greets each, and they re-auth without reconnecting.
      for (const id of r.clients.keys()) toDesktop(r, F.clientJoined(id));
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (F.isTunnelFrame(msg)) return fromDesktopTunnel(r, msg);
        if (!F.isClientFrame(msg)) return;
        // Route {c, d} back to the addressed client; d is opaque.
        const client = r.clients.get(msg.c);
        if (alive(client)) client.send(JSON.stringify(msg.d));
      });
      ws.on('close', () => {
        if (r.desktop !== ws) return; // a reconnect already replaced us
        r.desktop = null;
        for (const c of r.clients.values()) c.close(4002, 'desktop gone');
        r.clients.clear();
        for (const s of r.streams.values()) s.destroy();
        r.streams.clear();
        rooms.delete(roomId);
      });
      return;
    }

    const clientId = crypto.randomUUID();
    r.clients.set(clientId, ws);
    toDesktop(r, F.clientJoined(clientId));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      toDesktop(r, F.clientFrame(clientId, frame));
    });
    ws.on('close', () => {
      r.clients.delete(clientId);
      toDesktop(r, F.clientGone(clientId));
    });
  });

  // Bytes coming back up a forwarded-port stream.
  function fromDesktopTunnel(r, msg) {
    const socket = r.streams.get(msg.h);
    if (!socket) return;
    if (msg.t === 'data') return void socket.write(F.tunnelBytes(msg));
    if (msg.t === 'end') return void socket.end();
    if (msg.t === 'close') { r.streams.delete(msg.h); socket.destroy(); }
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

      const r = rooms.get(decision.room);
      if (!alive(r && r.desktop)) {
        return reply(socket, '502 Bad Gateway', 'That desktop is offline. Open the IDE and try again.\n');
      }

      // Splice. From here the connection is opaque bytes in both directions —
      // including the websocket upgrade a dev server's HMR client will make.
      const id = nextStream++;
      r.streams.set(id, socket);
      toDesktop(r, F.tunnelOpen(id, decision.port));
      toDesktop(r, F.tunnelData(id, head)); // the head we read is part of the stream

      socket.on('data', (b) => toDesktop(r, F.tunnelData(id, b)));
      socket.on('end', () => toDesktop(r, F.tunnelEnd(id)));
      socket.on('close', () => {
        if (r.streams.delete(id)) toDesktop(r, F.tunnelClose(id));
      });
      socket.resume();
    };

    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    demuxer.on('error', reject);
    demuxer.listen(port, host, () => resolve({
      port: demuxer.address().port,
      close: () => new Promise((res) => {
        for (const c of wss.clients) c.terminate();
        for (const r of rooms.values()) for (const s of r.streams.values()) s.destroy();
        rooms.clear();
        demuxer.close(() => res());
      }),
    }));
  });
}

module.exports = { startRelay };
