const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig, isRoom, DEFAULT_PORT, DEFAULT_RELAY_URL } = require('../src/main/remote-config-lib');

// The room id is minted when it's missing, so pin it to keep these deterministic.
const room = () => 'fixed-room-id';
const norm = (raw) => normalizeConfig(raw, room);

test('missing or corrupt config reads as off, on the default port and relay', () => {
  for (const raw of [null, undefined, 'nonsense', 42, []]) {
    assert.deepEqual(norm(raw), {
      enabled: false, port: DEFAULT_PORT, relayUrl: DEFAULT_RELAY_URL, room: 'fixed-room-id',
    });
  }
});

test('a saved config round-trips', () => {
  const saved = { enabled: true, port: 47823, relayUrl: 'https://relay.example', room: 'abcdefgh' };
  assert.deepEqual(norm(saved), saved);
});

test('enabled is strict — a truthy value is not an opt-in', () => {
  assert.equal(norm({ enabled: 'yes' }).enabled, false);
  assert.equal(norm({ enabled: 1 }).enabled, false);
});

// A phone dials the stored port, so an unusable one must fall back to a fixed
// default rather than to 0 (which the ws server reads as "any ephemeral port" —
// exactly the moving address this config exists to prevent).
test('an out-of-range or non-integer port falls back to the default', () => {
  for (const port of [0, -1, 65536, 1.5, '47823', null]) {
    assert.equal(norm({ enabled: true, port }).port, DEFAULT_PORT);
  }
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
