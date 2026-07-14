// Pure routing for the relay's single public port. Render gives us one port, so
// four kinds of traffic arrive on it and we tell them apart from the request
// head alone — the relay reads exactly enough to route and never parses a body.
//
//   /p/<room>/<instance>/<port>/…  an entry URL from the phone's Ports tab: 302 to
//                                  the site root, remembering the target in a cookie
//   Cookie: _idetunnel=…           anything below that root — pages, assets, the HMR
//                                  websocket — spliced raw to that desktop
//   Upgrade: websocket             /?role=desktop|mobile — the IDE protocol itself
//   otherwise                      health check
//
// The cookie is what lets the tunnel live at the site root, which is the whole
// point: a dev server emits absolute asset paths (/assets/x.js), so serving it
// under a /p/<room>/<port>/ prefix would mean rewriting every URL it produces.
// Routing by cookie instead of by path means no rewriting at all.
//
// The target is a window, not just a machine: two instances on one desktop can each
// be proxying the same dev-server port, and only the one that minted the URL's auth
// token will accept it — so a room id alone would hand the browser to a coin flip.

const { parseCookies } = require('./http-proxy-lib');

const TUNNEL_COOKIE = '_idetunnel';
const MAX_HEAD = 64 * 1024; // a request head past this is not a browser

// The relay is deployed on its own and outlives any one desktop build, so it still
// meets desktops from before windows were addressable. They name no instance; this
// stands in for one, and is deliberately not a number so it can never be confused
// with the port in the `/p/…` form below.
const DEFAULT_INSTANCE = 'default';

// Split a raw head ("GET / HTTP/1.1\r\nHost: …\r\n\r\n") into its parts.
// Malformed input from the network is expected, not a bug: return null.
function parseHead(text) {
  const lines = String(text).split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] || '');
  if (!m) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    if (!line) break;
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { method: m[1], target: m[2], headers };
}

// A room id and an instance id are ours (uuids) and a port is a port; anything else
// is someone poking at the relay, and must not reach a desktop.
const isRoom = (s) => /^[a-zA-Z0-9-]{8,64}$/.test(s);
const isInstance = (s) => /^[a-zA-Z0-9-]{1,64}$/.test(s);
const isPort = (s) => /^\d{1,5}$/.test(s) && Number(s) > 0 && Number(s) < 65536;

// `/p/<room>/<instance>/<port>` — or `/p/<room>/<port>`, which an older desktop mints.
// The two are told apart without ambiguity because an instance id is never a bare
// number: if the segment after the room parses as a port, there is no instance.
function parseEntry(segments) {
  const [room, second, third, ...rest] = segments;
  return isPort(second)
    ? { room, instance: DEFAULT_INSTANCE, port: second, rest: [third, ...rest] }
    : { room, instance: second, port: third, rest };
}

function route({ target, headers }) {
  const [path, query = ''] = String(target).split('?');

  // Entry URL first, so opening a second port switches the cookie rather than
  // being swallowed by the tunnel the first one installed.
  const entry = /^\/p\/(.+)$/.exec(path);
  if (entry) {
    const { room, instance, port, rest } = parseEntry(entry[1].split('/'));
    if (!isRoom(room) || !isInstance(instance || '') || !isPort(port || '')) return { kind: 'deny' };
    const tail = rest.filter(Boolean).join('/');
    const location = (tail ? `/${tail}` : '/') + (query ? `?${query}` : '');
    return {
      kind: 'entry',
      room,
      instance,
      port: Number(port),
      location,
      setCookie: `${TUNNEL_COOKIE}=${room}.${instance}.${port}; HttpOnly; Path=/; SameSite=Lax`,
    };
  }

  const cookie = parseCookies(headers.cookie)[TUNNEL_COOKIE];
  if (cookie) {
    // room.instance.port — or room.port from a cookie an older relay set, which is
    // still in the browser after a deploy. None of the three can contain a dot.
    const parts = cookie.split('.');
    const [room, instance, port] = parts.length === 2
      ? [parts[0], DEFAULT_INSTANCE, parts[1]]
      : parts;
    if (isRoom(room || '') && isInstance(instance || '') && isPort(port || '')) {
      return { kind: 'tunnel', room, instance, port: Number(port) };
    }
    return { kind: 'deny' };
  }

  // The IDE protocol. Checked after the cookie so an HMR websocket — which is
  // also an Upgrade, but carries the tunnel cookie — goes down the tunnel.
  if (String(headers.upgrade || '').toLowerCase() === 'websocket') return { kind: 'ws' };

  return { kind: 'health' };
}

module.exports = { parseHead, route, TUNNEL_COOKIE, MAX_HEAD, DEFAULT_INSTANCE };
