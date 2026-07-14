// Pure helpers for the persisted remote-access config (see remote.js).
//
// A paired phone dials the desktop by address and has no way to rediscover a new
// one, so two things must survive a restart: whether remote access was on, and
// the port it listened on. An ephemeral port would move on every launch and
// silently strand every paired device.

const DEFAULT_PORT = 47823;

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const valid = Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536;
  return { enabled: cfg.enabled === true, port: valid ? cfg.port : DEFAULT_PORT };
}

module.exports = { normalizeConfig, DEFAULT_PORT };
