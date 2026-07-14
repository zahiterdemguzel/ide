// Standalone cloud relay: bridges sockets between a desktop app and its mobile
// clients when they are not on the same LAN. Deliberately logic-free — it never
// parses protocol frames; pair/auth/req/res/ev messages pass through verbatim
// and are verified end-to-end by the desktop. Rooms are keyed by a random id
// the desktop generates; a mobile client learns the room id from the QR code.
//
//   desktop:  ws://relay/?role=desktop&room=<id>
//   mobile:   ws://relay/?role=mobile&room=<id>
//
// Frames from a mobile socket are wrapped as {c:<clientId>, d:<frame>} toward
// the desktop so one desktop socket can serve many phones; the desktop answers
// with the same envelope and the relay routes `d` back to that client. This
// envelope is the relay's ONLY vocabulary.

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

function startRelay({ port, host = '0.0.0.0' } = {}) {
  const rooms = new Map(); // roomId -> { desktop: ws|null, clients: Map<clientId, ws> }

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ide-relay ok\n');
  });
  const wss = new WebSocketServer({ server: httpServer });

  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { desktop: null, clients: new Map() });
    return rooms.get(id);
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://relay');
    const role = url.searchParams.get('role');
    const roomId = url.searchParams.get('room');
    if (!roomId || (role !== 'desktop' && role !== 'mobile')) return ws.close(4000, 'bad params');
    const r = room(roomId);

    if (role === 'desktop') {
      if (r.desktop) r.desktop.close(4001, 'replaced');
      r.desktop = ws;
      ws.on('message', (raw) => {
        // Route {c, d} back to the addressed client; d is opaque.
        let env;
        try { env = JSON.parse(raw.toString()); } catch { return; }
        const client = r.clients.get(env.c);
        if (client && client.readyState === client.OPEN) client.send(JSON.stringify(env.d));
      });
      ws.on('close', () => {
        if (r.desktop === ws) r.desktop = null;
        for (const c of r.clients.values()) c.close(4002, 'desktop gone');
        r.clients.clear();
        if (!r.desktop) rooms.delete(roomId);
      });
      return;
    }

    const clientId = crypto.randomUUID();
    r.clients.set(clientId, ws);
    ws.on('message', (raw) => {
      if (r.desktop && r.desktop.readyState === r.desktop.OPEN) {
        r.desktop.send(JSON.stringify({ c: clientId, d: JSON.parse(raw.toString()) }));
      }
    });
    ws.on('close', () => {
      r.clients.delete(clientId);
      if (r.desktop && r.desktop.readyState === r.desktop.OPEN) {
        r.desktop.send(JSON.stringify({ c: clientId, gone: true }));
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => resolve({
      port: httpServer.address().port,
      close: () => new Promise((res) => { for (const c of wss.clients) c.terminate(); httpServer.close(() => res()); }),
    }));
  });
}

module.exports = { startRelay };
