'use strict';

// Pure, Electron-free logic behind the account proxy (account-proxy.js, see
// .claude/memory/accounts.md). Unit-tested in test/account-proxy-lib.test.js.
//
// Every Claude session this app instance spawns talks to Anthropic through a
// local proxy that swaps the session's own login for the login of the account
// active in this instance. Switching accounts then just changes which login the
// proxy adds — the running CLI never restarts and a turn in flight carries on.

const UPSTREAM_HOST = 'api.anthropic.com';

// A login the proxy read is re-read this often even while it looks valid, so a
// token the CLI renewed (or a re-sign-in) is picked up without waiting for a 401.
const LOGIN_REREAD_MS = 60 * 1000;
// Renew a little before the stored expiry rather than racing it mid-request.
const LOGIN_EXPIRY_MARGIN_MS = 60 * 1000;

// Hop-by-hop headers belong to one connection and must not be forwarded; the body
// is buffered, so its length is re-stated rather than streamed in chunks.
const HOP_BY_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'upgrade', 'te', 'trailer',
];

// Env that makes the CLI talk to someone other than api.anthropic.com, or log in
// by other means than its stored claude.ai login. A session with any of these is
// left alone: the proxy only knows how to stand in for a claude.ai subscription.
const FOREIGN_ROUTE_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
];

// Whether a session can be routed through the proxy, given the env it will be
// spawned with and the `env` block of the user's Claude settings (which the CLI
// applies over the process env, so a base URL set there would bypass us).
function canRouteThroughProxy(spawnEnv, settingsEnv) {
  return FOREIGN_ROUTE_ENV.every((name) => !(spawnEnv && spawnEnv[name]) && !(settingsEnv && settingsEnv[name]));
}

// The env that points a spawned CLI at the proxy.
function proxyRouteEnv(port) {
  return { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
}

// Whether a request carries a claude.ai login (an OAuth bearer) for the proxy to
// replace. Requests without one (the CLI's connectivity HEAD) pass through as-is.
function carriesClaudeLogin(headers) {
  return !!headers && /^Bearer\s+\S/i.test(headers.authorization || '') && !headers['x-api-key'];
}

// The headers to send upstream: the incoming ones minus hop-by-hop headers, with
// the upstream host, the buffered body's length, and — when `token` is given —
// that login in place of the session's own.
function upstreamHeaders(incoming, token, bodyLength) {
  const headers = { ...incoming };
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  headers.host = UPSTREAM_HOST;
  if (bodyLength > 0 || headers['content-length'] !== undefined) headers['content-length'] = String(bodyLength);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

// Whether a cached login ({ token, expiresAt, readAt }) can be used without
// reading the credential store again.
function isCachedLoginFresh(entry, now) {
  if (!entry || !entry.token) return false;
  if (now - entry.readAt >= LOGIN_REREAD_MS) return false;
  return !entry.expiresAt || now < entry.expiresAt - LOGIN_EXPIRY_MARGIN_MS;
}

// What to do with a stored login (pickOauthCreds' shape) before using it:
// 'use' it, 'renew' it first (ran out, but a refresh token exists — the CLI renews
// it), or 'none' (no usable login: the request keeps the session's own).
function loginAction(creds) {
  if (!creds || !creds.accessToken) return 'none';
  if (!creds.expired) return 'use';
  return creds.hasRefreshToken ? 'renew' : 'none';
}

// Whether an upstream answer means the injected login was refused, so the proxy
// should renew it and try once more rather than hand the CLI a 401 for a login
// that isn't even its own.
function isLoginRefused(status) {
  return status === 401;
}

module.exports = {
  UPSTREAM_HOST, LOGIN_REREAD_MS, LOGIN_EXPIRY_MARGIN_MS, FOREIGN_ROUTE_ENV,
  canRouteThroughProxy, proxyRouteEnv, carriesClaudeLogin, upstreamHeaders,
  isCachedLoginFresh, loginAction, isLoginRefused,
};
