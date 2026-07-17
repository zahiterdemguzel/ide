// Pure decisions for the dev-server reverse proxy: URL-token/cookie auth, the
// redirect that swaps the one-time URL token for a session cookie, and the two
// response headers that have to be rewritten for the forwarded site to behave
// like a site. No sockets here — http-proxy.js applies these to real requests.

const crypto = require('crypto');

const COOKIE = '_ideauth';
const TOKEN_PARAM = '_ideauth';
const TOKEN_TTL_MS = 10 * 60 * 1000;

// Hop-by-hop headers must not be forwarded in either direction (RFC 7230 §6.1).
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// Anything the dev server thinks of as "itself".
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(?=[/?#]|$)/i;

const newUrlToken = () => crypto.randomBytes(16).toString('base64url');

// One proxy = one target port = one token state. The URL token is multi-use
// within its TTL (a page reload before the cookie lands must still work) but
// each successful use issues the same session cookie value.
function createAuthState(now = Date.now) {
  let urlToken = null;
  let expiresAt = 0;
  const cookieValue = newUrlToken(); // per-proxy session secret

  return {
    issueUrlToken() {
      urlToken = newUrlToken();
      expiresAt = now() + TOKEN_TTL_MS;
      return urlToken;
    },
    cookieValue,
    // Decide what to do with an incoming request (pathWithQuery + cookie header):
    //  { action: 'redirect', location, setCookie } — valid URL token: set cookie, strip token
    //  { action: 'proxy' }                         — valid cookie
    //  { action: 'deny' }                          — neither
    decide(url, cookieHeader) {
      const cookies = parseCookies(cookieHeader);
      // Constant-time: this long-lived session secret is the more valuable of the two
      // credentials, so it gets at least the same care as the short-lived URL token.
      if (cookies[COOKIE] !== undefined && safeEqual(cookies[COOKIE], cookieValue)) return { action: 'proxy' };
      const [path, query = ''] = url.split('?');
      const params = new URLSearchParams(query);
      const token = params.get(TOKEN_PARAM);
      if (token && urlToken && now() <= expiresAt && safeEqual(token, urlToken)) {
        params.delete(TOKEN_PARAM);
        const rest = params.toString();
        return {
          action: 'redirect',
          location: rest ? `${path}?${rest}` : path,
          setCookie: `${COOKIE}=${cookieValue}; HttpOnly; Path=/; SameSite=Lax`,
        };
      }
      return { action: 'deny' };
    },
  };
}

// The proxy sends the dev server its own Host (127.0.0.1:<target>), because dev
// servers check it — so anything it builds from that Host points at localhost.
// `/admin` answered with `Location: http://127.0.0.1:3000/login` would send the
// *phone's* browser to the phone's own localhost. Reduce such a redirect to a
// path and let the browser resolve it against whatever address it came in on:
// the LAN proxy or the relay, without either having to know which it is.
function rewriteLocation(value, targetPort) {
  const m = LOCAL_ORIGIN.exec(String(value ?? ''));
  if (!m) return value; // relative already, or a genuinely elsewhere host
  if (m[1] && Number(m[1]) !== Number(targetPort)) return value; // a different local service
  const rest = String(value).slice(m[0].length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

// A session cookie a /login page sets is dropped by the browser unless it can
// keep it: `Domain=localhost` names a host the phone isn't on, and `Secure` is
// unusable over the LAN proxy's plain http. Drop both and let it default to
// host-only on the origin the browser actually used. SameSite=None is the one
// exception — browsers reject it without Secure, so that pair stays together.
function rewriteSetCookie(value) {
  const attrs = String(value).split(';');
  const sameSiteNone = attrs.some((a) => /^\s*samesite\s*=\s*none\s*$/i.test(a));
  return attrs
    .filter((a, i) => i === 0 || !/^\s*domain\s*=/i.test(a))
    .filter((a, i) => i === 0 || sameSiteNone || !/^\s*secure\s*$/i.test(a))
    .join(';');
}

// Dev servers guard mutating requests with a CSRF/DNS-rebinding check: the
// request's Origin (or Referer) must match their own Host. We hand them
// Host: 127.0.0.1:<target>, so an Origin naming the address the browser really
// used — the relay or the LAN proxy — fails that check and a login POST is
// refused while every GET works. Rewrite the two to the upstream's own origin,
// but only when they name the proxy's public host: a genuinely cross-origin
// Origin (an OAuth provider posting back) is not ours to disguise.
function rewriteRequestOrigin(value, publicHost, targetPort) {
  try {
    const u = new URL(String(value));
    if (!publicHost || u.host.toLowerCase() !== String(publicHost).toLowerCase()) return value;
    const rest = u.pathname === '/' && !u.search ? '' : u.pathname + u.search;
    return `http://127.0.0.1:${targetPort}${rest}`;
  } catch {
    return value; // 'null', or not a URL — leave it alone
  }
}

function rewriteResponseHeaders(headers, targetPort) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (HOP.has(key)) continue;
    if (key === 'location') out[k] = rewriteLocation(v, targetPort);
    else if (key === 'set-cookie') out[k] = [].concat(v).map(rewriteSetCookie);
    else out[k] = v;
  }
  return out;
}

// The path a forwarded link should land on ('/admin', '/login?next=/x'). Comes
// from the phone, so it may be anything: keep it a path on *this* site — never
// an absolute or protocol-relative URL that would carry the auth token off to
// another origin.
function normalizeForwardPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw === '/') return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return ''; // scheme: not a path
  const path = `/${raw.replace(/^\/+/, '')}`; // also kills protocol-relative //host
  return /[\r\n]/.test(path) ? '' : path;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  createAuthState,
  parseCookies,
  rewriteLocation,
  rewriteSetCookie,
  rewriteRequestOrigin,
  rewriteResponseHeaders,
  normalizeForwardPath,
  COOKIE,
  TOKEN_PARAM,
  TOKEN_TTL_MS,
  HOP,
};
