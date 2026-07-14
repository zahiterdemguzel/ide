// Pairing and device-credential logic. Pure: the device store is injected as
// a plain object ({ load(), save(list) }) so tests and the desktop app supply
// their own persistence. Tokens are random 32-byte base64url strings; only
// sha256 hashes of device tokens are ever persisted.

const crypto = require('crypto');

const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_PAIR_FAILURES = 3;

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// timingSafeEqual requires equal lengths; sha256 hex always is.
function hashMatches(token, tokenHash) {
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(tokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One live pairing token at a time. Single-use, TTL-bound, invalidated after
// repeated failures so the QR can't be brute-forced while displayed.
function createPairingState(now = Date.now) {
  let current = null; // { token, expiresAt, failures }
  return {
    issue() {
      current = { token: newToken(), expiresAt: now() + PAIR_TOKEN_TTL_MS, failures: 0 };
      return current.token;
    },
    // Consume on success; count and eventually invalidate on failure.
    consume(candidate) {
      if (!current || now() > current.expiresAt) { current = null; return false; }
      const a = Buffer.from(candidate);
      const b = Buffer.from(current.token);
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok) { current = null; return true; }
      if (++current.failures >= MAX_PAIR_FAILURES) current = null;
      return false;
    },
    clear() { current = null; },
    active() { return !!current && now() <= current.expiresAt; },
  };
}

// Device records: [{ id, name, tokenHash, createdAt, lastSeen }]
function createDevice(store, name, now = Date.now) {
  const token = newToken();
  const device = {
    id: crypto.randomUUID(),
    name: String(name).slice(0, 64),
    tokenHash: hashToken(token),
    createdAt: now(),
    lastSeen: now(),
  };
  store.save([...store.load(), device]);
  return { device, token };
}

function verifyDevice(store, token, now = Date.now) {
  const devices = store.load();
  const device = devices.find((d) => hashMatches(token, d.tokenHash));
  if (!device) return null;
  device.lastSeen = now();
  store.save(devices);
  return device;
}

function revokeDevice(store, id) {
  const devices = store.load();
  const next = devices.filter((d) => d.id !== id);
  store.save(next);
  return next.length < devices.length;
}

const listDevices = (store) => store.load().map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen }));

module.exports = {
  PAIR_TOKEN_TTL_MS, MAX_PAIR_FAILURES,
  newToken, hashToken, hashMatches,
  createPairingState, createDevice, verifyDevice, revokeDevice, listDevices,
};
