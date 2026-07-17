// Reverse proxy that exposes one desktop-local dev server (127.0.0.1:<target>)
// on the LAN so the phone's browser can open it. One listener per forwarded
// port, mounted at the root — so every path of the site (/login, /admin, its
// absolute asset URLs) is reachable unchanged, and the auth cookie is Path=/ so
// the browser can walk to any of them. Auth: a signed one-time URL (?_ideauth=…)
// swaps to an HttpOnly cookie on first hit (see http-proxy-lib.js). Raw socket
// piping on Upgrade keeps HMR/websockets working. Pure bridging, no app logic —
// the only headers rewritten are the ones that would otherwise hand a phone the
// desktop's own localhost (Host on the way in, Location/Set-Cookie on the way out).

const http = require('http');
const net = require('net');
const {
  createAuthState, rewriteResponseHeaders, rewriteRequestOrigin, HOP,
} = require('./http-proxy-lib');
const { debugFor } = require('./debug');

const debug = debugFor('proxy');

const UPSTREAM_TIMEOUT_MS = 30000;

function startPortForward({ targetPort, host = '0.0.0.0', now } = {}) {
  const auth = createAuthState(now);

  const server = http.createServer((req, res) => {
    const verdict = auth.decide(req.url, req.headers.cookie);
    // The URL carries the one-time auth token, so log the path without its query.
    debug(verdict.action, { target: targetPort, method: req.method, path: req.url.split('?')[0] });
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
    // Dev servers check Host, and check Origin/Referer against it on mutating
    // requests (their CSRF guard) — a login POST needs all three to agree.
    if (headers.origin) headers.origin = rewriteRequestOrigin(headers.origin, req.headers.host, targetPort);
    if (headers.referer) headers.referer = rewriteRequestOrigin(headers.referer, req.headers.host, targetPort);
    headers.host = `127.0.0.1:${targetPort}`;
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
      (ur) => {
        debug('upstream', { target: targetPort, path: req.url.split('?')[0], status: ur.statusCode });
        res.writeHead(ur.statusCode, rewriteResponseHeaders(ur.headers, targetPort));
        ur.pipe(res);
      });
    // A hung dev server would otherwise pin this connection (and, over the relay, the
    // spliced tunnel stream) open forever. Give the upstream a deadline.
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('ETIMEDOUT')));
    upstream.on('error', (err) => {
      debug('upstream error', { target: targetPort, path: req.url.split('?')[0], error: err.code || err.message });
      // Once we've started piping the upstream body, the status line and headers are
      // already on the wire — appending an error string here would corrupt the body a
      // client is mid-read of. Reset the connection instead so it sees a clean failure.
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Bad gateway: nothing is listening on 127.0.0.1:${targetPort} (${err.code || err.message})\n`);
    });
    req.pipe(upstream);
  });

  // Websocket upgrades (Vite/webpack HMR): auth by cookie only (the browser
  // already holds it by the time a page opens a socket), then splice sockets.
  server.on('upgrade', (req, socket, head) => {
    if (auth.decide(req.url, req.headers.cookie).action !== 'proxy') {
      debug('upgrade denied', { target: targetPort, path: req.url.split('?')[0] });
      return socket.destroy();
    }
    debug('upgrade', { target: targetPort, path: req.url.split('?')[0] });
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const kl = k.toLowerCase();
        let v = req.rawHeaders[i + 1];
        if (kl === 'host') v = `127.0.0.1:${targetPort}`;
        // Vite runs the same Origin-vs-Host check on the HMR upgrade.
        else if (kl === 'origin') v = rewriteRequestOrigin(v, req.headers.host, targetPort);
        raw += `${kl === 'host' ? 'Host' : k}: ${v}\r\n`;
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
    server.listen(0, host, () => {
      debug('listening', { port: server.address().port, target: targetPort, host });
      resolve({
        port: server.address().port,
        targetPort,
        issueUrlToken: () => auth.issueUrlToken(),
        close: () => new Promise((res) => {
          debug('closing', { target: targetPort });
          server.closeAllConnections?.();
          server.close(() => res());
        }),
      });
    });
  });
}

module.exports = { startPortForward };
