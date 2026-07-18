// A tiny LAN HTTP server that hands a paired phone a whole .apk to download.
//
// Why HTTP and not the socket: an .apk is tens to hundreds of MB. Streaming it as
// base64 over the relay socket forces the phone to hold the entire file as one JS
// string to write it — which overflows Hermes' string cap — and each frame must
// also stay under the relay's 16MB limit. A plain HTTP GET lets the phone's
// `downloadAsync` stream straight to disk, no giant string, no framing. On the same
// Wi-Fi (Expo Go, or a phone beside the machine) this is the only transfer that
// works for a large file; off-LAN the caller falls back to the chunked socket read.
//
// A paired phone already has full repo read access over the socket, so serving a
// file it asks for is the same trust tier — but the URL is still gated by a random
// 128-bit token that expires, so a stale link (or a LAN neighbour) can't pull it.
const http = require('http');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const TOKEN_TTL_MS = 5 * 60 * 1000;
let server = null;
let port = 0;
const tokens = new Map(); // token -> { absPath, name, expires }

// Every address a phone on the same network might dial, private ranges first — a dev
// box commonly has several (real Wi-Fi plus VirtualBox/Hyper-V/VPN adapters) and we
// can't tell from here which one the phone shares, so we hand back all of them and
// let the phone try each. Empty when the machine has no LAN address at all.
function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
  }
  const isPrivate = (a) => a.startsWith('192.168.') || a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return addrs.sort((a, b) => isPrivate(b) - isPrivate(a));
}

function purge() {
  const now = Date.now();
  for (const [t, e] of tokens) if (e.expires < now) tokens.delete(t);
}

function ensureServer() {
  if (server) return Promise.resolve();
  server = http.createServer((req, res) => {
    purge();
    const m = /^\/apk\/([a-f0-9]{32})$/.exec((req.url || '').split('?')[0]);
    const entry = m && tokens.get(m[1]);
    if (!entry) { res.writeHead(404); res.end('not found'); return; }
    let st;
    try { st = fs.statSync(entry.absPath); } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${entry.name}"`,
    });
    fs.createReadStream(entry.absPath).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0 so the phone can reach it; the token is what actually guards a file.
    server.listen(0, '0.0.0.0', () => { port = server.address().port; resolve(); });
  });
}

// Publish `absPath` under a fresh token. Returns one candidate URL per LAN address
// (empty when there's none, or when a firewall silently eats them — the phone can't
// tell, so it also gets `port` + `path` to reach the same server through the relay
// port-forward proxy, which rides the desktop's *outbound* relay connection and so
// works even when inbound LAN connections are blocked).
async function publishApk(absPath, name) {
  await ensureServer();
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { absPath, name, expires: Date.now() + TOKEN_TTL_MS });
  const apkPath = `/apk/${token}`;
  return { urls: lanAddresses().map((host) => `http://${host}:${port}${apkPath}`), port, path: apkPath };
}

module.exports = { publishApk };
