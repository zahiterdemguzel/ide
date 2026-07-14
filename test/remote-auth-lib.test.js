const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../server/auth-lib');

const memStore = (initial = []) => {
  let list = initial;
  return { load: () => list.map((d) => ({ ...d })), save: (next) => { list = next; } };
};

test('pairing token is single-use and TTL-bound', () => {
  let t = 0;
  const pairing = auth.createPairingState(() => t);
  const token = pairing.issue();
  assert.equal(pairing.active(), true);
  assert.equal(pairing.consume(token), true);
  assert.equal(pairing.consume(token), false); // single use
  const token2 = pairing.issue();
  t += auth.PAIR_TOKEN_TTL_MS + 1;
  assert.equal(pairing.consume(token2), false); // expired
  assert.equal(pairing.active(), false);
});

test('pairing token invalidated after repeated failures', () => {
  const pairing = auth.createPairingState(() => 0);
  const token = pairing.issue();
  for (let i = 0; i < auth.MAX_PAIR_FAILURES; i++) assert.equal(pairing.consume('wrong-' + i), false);
  assert.equal(pairing.consume(token), false); // brute-force lockout killed it
});

test('device create/verify/revoke, only hashes persisted', () => {
  const store = memStore();
  const { device, token } = auth.createDevice(store, 'My Phone');
  assert.equal(store.load()[0].tokenHash, auth.hashToken(token));
  assert.ok(!JSON.stringify(store.load()).includes(token));

  const verified = auth.verifyDevice(store, token);
  assert.equal(verified.id, device.id);
  assert.equal(auth.verifyDevice(store, 'bogus-token'), null);

  assert.equal(auth.revokeDevice(store, device.id), true);
  assert.equal(auth.verifyDevice(store, token), null);
  assert.equal(auth.revokeDevice(store, device.id), false);
});

test('listDevices omits tokenHash', () => {
  const store = memStore();
  auth.createDevice(store, 'A');
  const [d] = auth.listDevices(store);
  assert.deepEqual(Object.keys(d).sort(), ['createdAt', 'id', 'lastSeen', 'name']);
});

test('device name is truncated', () => {
  const store = memStore();
  const { device } = auth.createDevice(store, 'x'.repeat(200));
  assert.equal(device.name.length, 64);
});
