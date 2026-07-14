// Pure decisions for the dev-server reverse proxy: URL-token/cookie auth and
// the redirect that swaps the one-time URL token for a session cookie. No
// sockets here — http-proxy.js applies these to real requests.

const crypto = require('crypto');

const COOKIE = '_ideauth';
const TOKEN_PARAM = '_ideauth';
const TOKEN_TTL_MS = 10 * 60 * 1000;

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
      if (cookies[COOKIE] === cookieValue) return { action: 'proxy' };
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

module.exports = { createAuthState, parseCookies, COOKIE, TOKEN_PARAM, TOKEN_TTL_MS };
