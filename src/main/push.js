// Sends OS push notifications to paired phones through Expo's push service. This
// is how a phone hears about a session finishing while the app is closed — the
// mobile app deliberately holds no background socket (battery), so the platform
// push channel (FCM/APNs, via Expo) is the only path that reaches a sleeping phone.
//
// Thin by design: every decision lives in push-lib.js. remote.js injects the
// device store and mirrors the service's enabled flag; sessions.js just calls
// notifySessionCompleted and never learns about devices or tokens.

const { EXPO_PUSH_URL, isExpoPushToken, buildPushMessages, tokensToDrop, withPushToken } = require('./push-lib');

let deviceStore = null;
let enabled = false;

function init(store) { deviceStore = store; }
function setEnabled(v) { enabled = v; }

// register-push from a phone: remember (or clear, token === null) its Expo push
// token on its device record. Returns true when accepted.
function registerToken(deviceId, token) {
  if (!deviceStore || !deviceId) return false;
  if (token !== null && !isExpoPushToken(token)) return false;
  const next = withPushToken(deviceStore.load(), deviceId, token);
  if (next) deviceStore.save(next);
  return true;
}

async function post(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const body = await res.json().catch(() => null);
  // A token Expo says is permanently dead (app uninstalled) is dropped so later
  // notifications stop paying for it.
  for (const token of tokensToDrop(messages, body && body.data)) {
    const devices = deviceStore.load();
    const gone = devices.find((d) => d.pushToken === token);
    if (gone) deviceStore.save(withPushToken(devices, gone.id, null) || devices);
  }
}

// Fire-and-forget: a push failing (offline, Expo hiccup) must never affect the
// session it reports on.
function notifySessionCompleted({ id, title }) {
  if (!enabled || !deviceStore) return;
  const messages = buildPushMessages(deviceStore.load(), {
    title: title || 'Claude session',
    body: 'Session completed',
    data: { sessionId: id },
  });
  if (!messages.length) return;
  post(messages).catch((err) => console.error('[push]', err));
}

module.exports = { init, setEnabled, registerToken, notifySessionCompleted };
