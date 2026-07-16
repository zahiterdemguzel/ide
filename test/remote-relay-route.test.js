const { test } = require('node:test');
const assert = require('node:assert');
const { parseHead, route, singleUseHead } = require('../server/relay-route');

const head = (target, headers = {}) => {
  const lines = [`GET ${target} HTTP/1.1`, 'Host: relay.example'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return parseHead(lines.join('\r\n'));
};

test('parseHead reads the request line and lowercases header names', () => {
  const h = parseHead('POST /x?a=1 HTTP/1.1\r\nHost: h\r\nCoOkIe: a=b');
  assert.deepEqual(h, { method: 'POST', target: '/x?a=1', headers: { host: 'h', cookie: 'a=b' } });
});

test('garbage never parses (it arrives from the open internet)', () => {
  for (const raw of ['', 'not http', 'GET', 'GET / HTTP/2.0', '\x00\x01\x02']) {
    assert.equal(parseHead(raw), null);
  }
});

test('the IDE websocket is routed to the relay itself', () => {
  const r = route(head('/?role=desktop&room=abcdefgh', { Upgrade: 'websocket' }));
  assert.equal(r.kind, 'ws');
});

test('an unremarkable request is the health check', () => {
  assert.equal(route(head('/')).kind, 'health');
  assert.equal(route(head('/healthz')).kind, 'health');
});

// The entry URL the Ports tab hands the phone's browser. It parks the target in a
// cookie and sends the browser to the site root, so the dev server's own absolute
// asset paths (/assets/x.js) resolve without any URL rewriting.
test('an entry URL redirects to the root and remembers room+instance+port in a cookie', () => {
  const r = route(head('/p/abcdefgh/win-1/3000/?_ideauth=T'));
  assert.equal(r.kind, 'entry');
  assert.equal(r.room, 'abcdefgh');
  assert.equal(r.instance, 'win-1');
  assert.equal(r.port, 3000);
  assert.equal(r.location, '/?_ideauth=T');
  assert.match(r.setCookie, /^_idetunnel=abcdefgh\.win-1\.3000;/);
  assert.match(r.setCookie, /HttpOnly/);
});

test('an entry URL with a deeper path keeps it', () => {
  assert.equal(route(head('/p/abcdefgh/win-1/3000/admin?x=1')).location, '/admin?x=1');
  assert.equal(route(head('/p/abcdefgh/win-1/3000/a/b/c')).location, '/a/b/c');
  assert.equal(route(head('/p/abcdefgh/win-1/3000')).location, '/');
});

test('anything below the root goes down the tunnel named by the cookie', () => {
  const r = route(head('/assets/app.js', { Cookie: '_idetunnel=abcdefgh.win-1.3000' }));
  assert.deepEqual(r, { kind: 'tunnel', room: 'abcdefgh', instance: 'win-1', port: 3000, upgrade: false });
});

// The dev server's HMR client opens a websocket. It is an Upgrade like the IDE's
// own, and is told apart only by the tunnel cookie — so the cookie must be checked
// first, or HMR would be handed to the relay's ws server and die.
test('an HMR websocket carries the tunnel cookie and is tunnelled, not claimed', () => {
  const r = route(head('/', { Upgrade: 'websocket', Cookie: '_idetunnel=abcdefgh.win-1.3000' }));
  assert.deepEqual(r, { kind: 'tunnel', room: 'abcdefgh', instance: 'win-1', port: 3000, upgrade: true });
});

// Opening a second port must switch the cookie rather than being swallowed by the
// tunnel the first one installed.
test('an entry URL wins over an existing tunnel cookie', () => {
  const r = route(head('/p/abcdefgh/win-1/5173/', { Cookie: '_idetunnel=abcdefgh.win-1.3000' }));
  assert.equal(r.kind, 'entry');
  assert.equal(r.port, 5173);
});

// Two windows on one machine can each be proxying port 3000, and the auth token in the
// entry URL is only good at the proxy that minted it — so the window, not just the
// machine, is what the cookie has to carry.
test('the same port on two windows routes to two different desktops', () => {
  const a = route(head('/x', { Cookie: '_idetunnel=abcdefgh.win-1.3000' }));
  const b = route(head('/x', { Cookie: '_idetunnel=abcdefgh.win-2.3000' }));
  assert.equal(a.instance, 'win-1');
  assert.equal(b.instance, 'win-2');
});

// The relay is deployed on its own and outlives any one desktop build, so it still
// meets desktops that name no window — and browsers still holding their cookies.
test('a desktop from before windows were addressable still routes, as the default one', () => {
  const entry = route(head('/p/abcdefgh/3000/?_ideauth=T'));
  assert.equal(entry.kind, 'entry');
  assert.equal(entry.instance, 'default');
  assert.equal(entry.port, 3000);
  assert.equal(entry.location, '/?_ideauth=T');
  assert.equal(route(head('/p/abcdefgh/3000/admin')).location, '/admin');

  const tunnel = route(head('/x', { Cookie: '_idetunnel=abcdefgh.3000' }));
  assert.deepEqual(tunnel, { kind: 'tunnel', room: 'abcdefgh', instance: 'default', port: 3000, upgrade: false });
});

// The relay routes a connection once, so a routed request must be the only one its
// connection ever carries: Connection: close is forced into the head, replacing
// whatever keep-alive intent the client (or a pooling front proxy) sent.
test('singleUseHead forces Connection: close and drops keep-alive headers', () => {
  const raw = Buffer.from('GET /login HTTP/1.1\r\nHost: h\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nCookie: a=b\r\n\r\n');
  const out = singleUseHead(raw).toString();
  assert.match(out, /^GET \/login HTTP\/1\.1\r\n/);
  assert.match(out, /\r\nConnection: close\r\n\r\n$/);
  assert.doesNotMatch(out, /keep-alive/i);
  assert.match(out, /\r\nCookie: a=b\r\n/);
});

test('singleUseHead preserves body bytes already read past the head', () => {
  const raw = Buffer.from('POST /api/login HTTP/1.1\r\nHost: h\r\nContent-Length: 7\r\n\r\n{"a":1}');
  const out = singleUseHead(raw).toString();
  assert.match(out, /\r\nConnection: close\r\n\r\n\{"a":1\}$/);
});

test('singleUseHead leaves an incomplete head untouched', () => {
  const raw = Buffer.from('GET / HTTP/1.1\r\nHost: h\r\n');
  assert.equal(singleUseHead(raw), raw);
});

// A room id, an instance id and a port are the only things that may reach a desktop.
// Anything else in that cookie or path is someone poking at a public relay.
test('a malformed room, instance or port is denied, never routed', () => {
  assert.equal(route(head('/p/bad_room/win-1/3000/')).kind, 'deny');
  assert.equal(route(head('/p/short/win-1/3000/')).kind, 'deny');
  assert.equal(route(head('/p/abcdefgh/win-1/99999/')).kind, 'deny');
  assert.equal(route(head('/p/abcdefgh/win-1/notaport/')).kind, 'deny');
  assert.equal(route(head('/p/abcdefgh/bad_window/3000/')).kind, 'deny');
  assert.equal(route(head('/x', { Cookie: '_idetunnel=abcdefgh.win-1.0' })).kind, 'deny');
  assert.equal(route(head('/x', { Cookie: '_idetunnel=abcdefgh.bad_window.3000' })).kind, 'deny');
  assert.equal(route(head('/x', { Cookie: '_idetunnel=nonsense' })).kind, 'deny');
});
