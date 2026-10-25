const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeConfig, isRoom, resolveRelayUrl, relayUrlForPhone,
  DEFAULT_RELAY_URL,
} = require('../src/main/remote-config-lib');

// The room id is minted when it's missing, so pin it to keep these deterministic.
const room = () => 'fixed-room-id';
const norm = (raw) => normalizeConfig(raw, room);

test('missing or corrupt config reads as off, on the default relay', () => {
  for (const raw of [null, undefined, 'nonsense', 42, []]) {
    assert.deepEqual(norm(raw), {
      enabled: false, relayUrl: DEFAULT_RELAY_URL, room: 'fixed-room-id',
    });
  }
});

test('a saved config round-trips', () => {
  const saved = { enabled: true, relayUrl: 'https://relay.example', room: 'abcdefgh' };
  assert.deepEqual(norm(saved), saved);
});

test('enabled is strict — a truthy value is not an opt-in', () => {
  assert.equal(norm({ enabled: 'yes' }).enabled, false);
  assert.equal(norm({ enabled: 1 }).enabled, false);
});

// The room is the desktop's address on the relay and every paired phone holds it.
// A junk one must be replaced, not passed through to the relay.
test('a missing or malformed room is minted afresh', () => {
  for (const bad of [undefined, null, '', 'short', 'has spaces', 'x'.repeat(65), 42]) {
    assert.equal(norm({ room: bad }).room, 'fixed-room-id');
  }
  assert.equal(norm({ room: 'a-valid-room-1234' }).room, 'a-valid-room-1234');
});

test('a real room id survives normalizing, and a generated one is valid', () => {
  assert.ok(isRoom(normalizeConfig(null).room), 'the default generator must produce a valid room');
});

// The relay origin is baked in so a build reaches it unconfigured; anything that
// isn't an http(s) origin (a ws:// URL, a bare host) must not silently become one.
test('a non-http relay URL falls back to the default', () => {
  for (const relayUrl of ['ws://relay.example', 'relay.example', '', null, 42]) {
    assert.equal(norm({ relayUrl }).relayUrl, DEFAULT_RELAY_URL);
  }
  assert.equal(norm({ relayUrl: 'http://localhost:8080' }).relayUrl, 'http://localhost:8080');
});

// Dev and packaged runs both talk to the hosted relay unless configured otherwise.
test('resolveRelayUrl uses the hosted relay unless overridden', () => {
  assert.equal(resolveRelayUrl(), DEFAULT_RELAY_URL);

  const stored = 'https://relay.example';
  assert.equal(resolveRelayUrl({ stored }), stored);
  assert.equal(resolveRelayUrl({ stored: 'ws://nonsense' }), DEFAULT_RELAY_URL);

  // IDE_RELAY_URL wins (e.g. a local relay while debugging); junk in it is ignored.
  const env = { IDE_RELAY_URL: 'http://10.0.0.5:8080' };
  assert.equal(resolveRelayUrl({ env, stored }), 'http://10.0.0.5:8080');
  assert.equal(resolveRelayUrl({ env: { IDE_RELAY_URL: 'nonsense' } }), DEFAULT_RELAY_URL);
});

// `localhost` on a phone is the phone. The desktop still dials localhost itself;
// only what it *hands* a phone (QR, forwarded link) is rewritten.
test('the local relay is handed to a phone by LAN address, not as localhost', () => {
  assert.equal(relayUrlForPhone('http://localhost:8080', '192.168.1.42'), 'http://192.168.1.42:8080');
  assert.equal(relayUrlForPhone('http://127.0.0.1:8080/', '192.168.1.42'), 'http://192.168.1.42:8080/');
  // Nothing to rewrite: a real relay, or a machine with no LAN address to offer.
  assert.equal(relayUrlForPhone(DEFAULT_RELAY_URL, '192.168.1.42'), DEFAULT_RELAY_URL);
  assert.equal(relayUrlForPhone('http://localhost:8080', undefined), 'http://localhost:8080');
  // Not a host match — a hostname that merely starts with "localhost" is left alone.
  assert.equal(relayUrlForPhone('https://localhost.example.com', '192.168.1.42'), 'https://localhost.example.com');
});
