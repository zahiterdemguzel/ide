// Build-time defaults for the mobile app.
//
// The deployed relay (server/index.js on Render). Baked into the APK so the app
// can reach a desktop off-LAN even if the QR it scanned carried no relay origin;
// a QR that does carry one wins, which is what a self-hosted relay would set.
// Keep in step with DEFAULT_RELAY_URL in src/main/remote-config-lib.js.
const HOSTED_RELAY_URL = 'https://ide-yj3x.onrender.com';

// This is only ever a *fallback*: the QR a desktop shows always carries its own
// relay, so an Expo run paired with a dev desktop already follows that desktop to
// the local relay — nothing to configure. It matters for a QR that carries none,
// and there a build must reach the hosted relay while an Expo run should be able
// to reach yours: set EXPO_PUBLIC_RELAY_URL (e.g. http://192.168.1.42:8080 — a
// phone cannot dial your machine's `localhost`). Ignored in a build, on purpose.
export const DEFAULT_RELAY_URL = (__DEV__ && process.env.EXPO_PUBLIC_RELAY_URL) || HOSTED_RELAY_URL;
