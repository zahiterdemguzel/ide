// The account proxy: a loopback HTTP server every Claude session of this app
// instance sends its API traffic through (ANTHROPIC_BASE_URL), which forwards it
// to api.anthropic.com with the login of the account active *in this instance*
// in place of the session's own. Switching accounts therefore needs no restart:
// the next request a session makes simply goes out as the new account. The
// request body is forwarded byte for byte, so prompt caching keeps working — the
// only extra cost is the one cache write on the new account after a switch.
//
// One proxy per app instance (each is its own process with its own active
// account), started lazily on the first session spawn. The pure decisions live in
// account-proxy-lib.js; see .claude/memory/accounts.md.

const http = require('http');
const https = require('https');
const accounts = require('./accounts');
const { readOauthCredsAsync, runCli } = require('./claude');
const lib = require('./account-proxy-lib');

// account config dir ('' = default account) -> { token, expiresAt, readAt }
const loginCache = new Map();
// account config dir -> in-flight login read, so a burst of requests reads once
const pendingLogins = new Map();

const loginKey = (account) => account.configDir || '';

// The login to send as `account`, or null to leave the session's own in place.
// A login that ran out is handed to the CLI to renew (a one-line run as that
// account), exactly as the account menu's login check does — never refreshed
// here: refresh tokens rotate, and a renewal the CLI didn't store would sign the
// account out.
// `refusedToken` is a login the API just turned down: re-read, and renew only if
// the stored login is still that one.
function loginTokenFor(account, { refusedToken = null } = {}) {
  const key = loginKey(account);
  const cached = loginCache.get(key);
  if (!refusedToken && lib.isCachedLoginFresh(cached, Date.now())) return Promise.resolve(cached.token);
  if (pendingLogins.has(key)) return pendingLogins.get(key);
  const pending = readLogin(account, refusedToken).finally(() => pendingLogins.delete(key));
  pendingLogins.set(key, pending);
  return pending;
}

async function readLogin(account, refusedToken) {
  const key = loginKey(account);
  let creds = await readOauthCredsAsync(account.configDir);
  const stillRefused = !!refusedToken && !!creds && creds.accessToken === refusedToken;
  if (stillRefused || lib.loginAction(creds) === 'renew') {
    await runCli('.', { configDir: account.configDir });
    creds = await readOauthCredsAsync(account.configDir);
  }
  if (lib.loginAction(creds) !== 'use') {
    loginCache.delete(key);
    return null;
  }
  loginCache.set(key, { token: creds.accessToken, expiresAt: creds.expiresAt, readAt: Date.now() });
  return creds.accessToken;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Send one request upstream. Resolves with the upstream response, which the
// caller either streams back or discards to retry.
function sendUpstream(req, body, token, onRequest) {
  return new Promise((resolve, reject) => {
    const upstream = https.request({
      host: lib.UPSTREAM_HOST,
      path: req.url,
      method: req.method,
      headers: lib.upstreamHeaders(req.headers, token, body.length),
    }, resolve);
    upstream.on('error', reject);
    onRequest(upstream);
    upstream.end(body);
  });
}

async function handleRequest(req, res) {
  let upstream = null;
  // The CLI dropping the request (Esc mid-stream) must cancel ours too.
  res.on('close', () => { if (upstream && !res.writableFinished) upstream.destroy(); });
  const track = (r) => { upstream = r; };
  try {
    const body = await readBody(req);
    const account = accounts.activeAccount();
    const swapsLogin = lib.carriesClaudeLogin(req.headers);
    let token = swapsLogin ? await loginTokenFor(account) : null;
    let upstreamRes = await sendUpstream(req, body, token, track);
    if (token && lib.isLoginRefused(upstreamRes.statusCode)) {
      upstreamRes.resume();
      token = await loginTokenFor(account, { refusedToken: token });
      // Still no usable login: let the session's own go through rather than fail.
      upstreamRes = await sendUpstream(req, body, token, track);
    }
    if (res.destroyed) { upstreamRes.resume(); return; }
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    if (!res.destroyed) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `account proxy: ${err.message}` } }));
    }
  }
}

let started = null;

// The proxy's port, starting it on first use; null when it can't listen, in which
// case sessions spawn talking to Anthropic directly and switching restarts them.
function ensureAccountProxy() {
  if (!started) {
    started = new Promise((resolve) => {
      const server = http.createServer((req, res) => { handleRequest(req, res); });
      // Streams can idle for minutes while the model thinks; never time them out.
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.keepAliveTimeout = 60 * 1000;
      server.on('error', (err) => {
        console.warn('[account-proxy] could not start:', err.message);
        started = null;
        resolve(null);
      });
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
  }
  return started;
}

// A switch makes the next request read the new account's login fresh.
accounts.onActiveAccountChanged(() => loginCache.clear());

module.exports = { ensureAccountProxy };
