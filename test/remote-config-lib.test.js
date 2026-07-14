const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeConfig, DEFAULT_PORT } = require('../src/main/remote-config-lib');

test('missing or corrupt config reads as off, on the default port', () => {
  for (const raw of [null, undefined, 'nonsense', 42, []]) {
    assert.deepEqual(normalizeConfig(raw), { enabled: false, port: DEFAULT_PORT });
  }
});

test('a saved config round-trips', () => {
  assert.deepEqual(normalizeConfig({ enabled: true, port: 47823 }), { enabled: true, port: 47823 });
  assert.deepEqual(normalizeConfig({ enabled: false, port: 5000 }), { enabled: false, port: 5000 });
});

test('enabled is strict — a truthy value is not an opt-in', () => {
  assert.equal(normalizeConfig({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeConfig({ enabled: 1 }).enabled, false);
});

// A phone dials the stored port, so an unusable one must fall back to a fixed
// default rather than to 0 (which the ws server reads as "any ephemeral port" —
// exactly the moving address this config exists to prevent).
test('an out-of-range or non-integer port falls back to the default', () => {
  for (const port of [0, -1, 65536, 1.5, '47823', null]) {
    assert.equal(normalizeConfig({ enabled: true, port }).port, DEFAULT_PORT);
  }
});
