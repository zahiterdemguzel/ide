// Reverse proxy that exposes one desktop-local dev server (127.0.0.1:<target>)
// on the LAN so the phone's browser can open it. One listener per forwarded
// port — no path rewriting needed. Auth: a signed one-time URL (?_ideauth=…)
// swaps to an HttpOnly cookie on first hit (see http-proxy-lib.js). Raw socket
// piping on Upgrade keeps HMR/websockets working. Pure bridging, no app logic.

const http = require('http');
const net = require('net');
const { createAuthState } = require('./http-proxy-lib');

// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1).
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function startPortForward({ targetPort, host = '0.0.0.0', now } = {}) {
  const auth = createAuthState(now);

  const server = http.createServer((req, res) => {
    const verdict = auth.decide(req.url, req.headers.cookie);
    if (verdict.action === 'deny') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden: open this port from the IDE mobile app.\n');
    }
    if (verdict.action === 'redirect') {
      res.writeHead(302, { location: verdict.location, 'set-cookie': verdict.setCookie });
      return res.end();
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    headers.host = `127.0.0.1:${targetPort}`; // dev servers often check Host
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
      (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Bad gateway: nothing is listening on 127.0.0.1:${targetPort} (${err.code || err.message})\n`);
    });
    req.pipe(upstream);
  });

  // Websocket upgrades (Vite/webpack HMR): auth by cookie only (the browser
  // already holds it by the time a page opens a socket), then splice sockets.
  server.on('upgrade', (req, socket, head) => {
    if (auth.decide(req.url, req.headers.cookie).action !== 'proxy') return socket.destroy();
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        raw += `${k.toLowerCase() === 'host' ? 'Host' : k}: ${k.toLowerCase() === 'host' ? `127.0.0.1:${targetPort}` : req.rawHeaders[i + 1]}\r\n`;
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, host, () => resolve({
      port: server.address().port,
      targetPort,
      issueUrlToken: () => auth.issueUrlToken(),
      close: () => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }),
    }));
  });
}

module.exports = { startPortForward };
