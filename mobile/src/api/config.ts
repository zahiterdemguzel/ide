// Build-time defaults for the mobile app.
//
// The deployed relay (server/index.js on Render). Baked into the APK so the app
// can reach a desktop off-LAN even if the QR it scanned carried no relay origin;
// a QR that does carry one wins, which is what a self-hosted relay would set.
// Keep in step with DEFAULT_RELAY_URL in src/main/remote-config-lib.js.
export const DEFAULT_RELAY_URL = 'https://ide-yj3x.onrender.com';

// How long to wait for one endpoint before trying the next. The LAN address is
// tried first and, off that network, usually fails fast (unreachable) — but a
// network that black-holes the packets instead would otherwise hang the app, so
// give up and fall back to the relay.
export const DIAL_TIMEOUT_MS = 4000;
