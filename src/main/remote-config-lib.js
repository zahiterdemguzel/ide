// Pure helpers for the persisted remote-access config (see remote.js).
//
// A paired phone reaches the desktop through the relay and has no way to
// rediscover a new address, so what survives a restart is what it is holding:
// whether remote access was on, and the relay room it was reachable in. A fresh
// room id on every launch would silently strand every paired device.

const crypto = require('crypto');

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

// Which relay this run talks to. Dev and packaged runs both use the stored or
// hosted relay; `IDE_RELAY_URL` overrides it (e.g. a local relay while debugging).
function resolveRelayUrl({ env = {}, stored } = {}) {
  if (isHttpUrl(env.IDE_RELAY_URL)) return env.IDE_RELAY_URL;
  return isHttpUrl(stored) ? stored : DEFAULT_RELAY_URL;
}

// `localhost` names the *phone* when a phone reads it. The desktop keeps dialling
// the local relay at localhost (same machine, same relay), but everything handed
// to a phone — the QR's `relay=`, a forwarded dev-server link — has to name the
// address the phone can reach it at instead, or the dev relay is desktop-only.
function relayUrlForPhone(relayUrl, lanHost) {
  if (!lanHost) return relayUrl;
  return String(relayUrl).replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i, `$1${lanHost}`);
}

// A room id is the desktop's address on the relay: it goes in the QR and every
// paired phone keeps it. Must match the relay's own room pattern (relay-route.js).
const isRoom = (s) => typeof s === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(s);

function normalizeConfig(raw, newRoom = () => crypto.randomUUID()) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: cfg.enabled === true,
    relayUrl: isHttpUrl(cfg.relayUrl) ? cfg.relayUrl : DEFAULT_RELAY_URL,
    room: isRoom(cfg.room) ? cfg.room : newRoom(),
  };
}

module.exports = {
  normalizeConfig, isRoom, resolveRelayUrl, relayUrlForPhone, DEFAULT_RELAY_URL,
};
