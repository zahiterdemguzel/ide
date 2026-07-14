// Pure helpers for the persisted remote-access config (see remote.js).
//
// A paired phone dials the desktop by address and has no way to rediscover a new
// one, so what survives a restart is what it is holding: whether remote access was
// on, the LAN port it listened on, and the relay room it was reachable in. An
// ephemeral port or a fresh room id on every launch would silently strand every
// paired device.

const crypto = require('crypto');

const DEFAULT_PORT = 47823;

// The deployed relay (server/index.js on Render). Baked in so a build reaches it
// with no configuration; a stored relayUrl overrides it, which is what a
// self-hosted relay would set.
const DEFAULT_RELAY_URL = 'https://ide-yj3x.onrender.com';

const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
};

// A room id is the desktop's address on the relay: it goes in the QR and every
// paired phone keeps it. Must match the relay's own room pattern (relay-route.js).
const isRoom = (s) => typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s);

function normalizeConfig(raw, newRoom = () => crypto.randomUUID()) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const validPort = Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536;
  return {
    enabled: cfg.enabled === true,
    port: validPort ? cfg.port : DEFAULT_PORT,
    relayUrl: isHttpUrl(cfg.relayUrl) ? cfg.relayUrl : DEFAULT_RELAY_URL,
    room: isRoom(cfg.room) ? cfg.room : newRoom(),
  };
}

module.exports = { normalizeConfig, isRoom, DEFAULT_PORT, DEFAULT_RELAY_URL };
