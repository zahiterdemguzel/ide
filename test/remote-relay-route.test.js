const { test } = require('node:test');
const assert = require('node:assert');
const { parseHead, route } = require('../server/relay-route');

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

// The entry URL the Ports tab hands the phone's browser. It parks room+port in a
// cookie and sends the browser to the site root, so the dev server's own absolute
// asset paths (/assets/x.js) resolve without any URL rewriting.
test('an entry URL redirects to the root and remembers room+port in a cookie', () => {
  const r = route(head('/p/abcdefgh/3000/?_ideauth=T'));
  assert.equal(r.kind, 'entry');
  assert.equal(r.room, 'abcdefgh');
  assert.equal(r.port, 3000);
  assert.equal(r.location, '/?_ideauth=T');
  assert.match(r.setCookie, /^_idetunnel=abcdefgh\.3000;/);
  assert.match(r.setCookie, /HttpOnly/);
});

test('an entry URL with a deeper path keeps it', () => {
  assert.equal(route(head('/p/abcdefgh/3000/admin?x=1')).location, '/admin?x=1');
  assert.equal(route(head('/p/abcdefgh/3000')).location, '/');
});

test('anything below the root goes down the tunnel named by the cookie', () => {
  const r = route(head('/assets/app.js', { Cookie: '_idetunnel=abcdefgh.3000' }));
  assert.deepEqual(r, { kind: 'tunnel', room: 'abcdefgh', port: 3000 });
});

// The dev server's HMR client opens a websocket. It is an Upgrade like the IDE's
// own, and is told apart only by the tunnel cookie — so the cookie must be checked
// first, or HMR would be handed to the relay's ws server and die.
test('an HMR websocket carries the tunnel cookie and is tunnelled, not claimed', () => {
  const r = route(head('/', { Upgrade: 'websocket', Cookie: '_idetunnel=abcdefgh.3000' }));
  assert.deepEqual(r, { kind: 'tunnel', room: 'abcdefgh', port: 3000 });
});

// Opening a second port must switch the cookie rather than being swallowed by the
// tunnel the first one installed.
test('an entry URL wins over an existing tunnel cookie', () => {
  const r = route(head('/p/abcdefgh/5173/', { Cookie: '_idetunnel=abcdefgh.3000' }));
  assert.equal(r.kind, 'entry');
  assert.equal(r.port, 5173);
});

// A room id and a port are the only things that may reach a desktop. Anything else
// in that cookie or path is someone poking at a public relay.
test('a malformed room or port is denied, never routed', () => {
  assert.equal(route(head('/p/bad_room/3000/')).kind, 'deny');
  assert.equal(route(head('/p/short/3000/')).kind, 'deny');
  assert.equal(route(head('/p/abcdefgh/99999/')).kind, 'deny');
  assert.equal(route(head('/p/abcdefgh/notaport/')).kind, 'deny');
  assert.equal(route(head('/x', { Cookie: '_idetunnel=abcdefgh.0' })).kind, 'deny');
  assert.equal(route(head('/x', { Cookie: '_idetunnel=nonsense' })).kind, 'deny');
});
