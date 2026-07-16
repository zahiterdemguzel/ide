// Pure decisions for Expo push notifications: which paired devices get one, the
// message shape Expo's push API takes, and which stored tokens a response says to
// drop. No network, no Electron — the sender (push.js) stays a thin wrapper.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Expo push tokens look like ExponentPushToken[xxxx]. Anything else is refused at
// registration so a malformed remote frame can't park garbage in the device store.
const isExpoPushToken = (t) => typeof t === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(t);

// One message per device that has registered a push token. `data` rides to the
// tap handler on the phone (the session id the notification opens).
function buildPushMessages(devices, { title, body, data }) {
  return (devices || [])
    .filter((d) => isExpoPushToken(d.pushToken))
    .map((d) => ({ to: d.pushToken, title, body, data, sound: 'default', priority: 'high' }));
}

// Expo answers one ticket per message, in order. DeviceNotRegistered means the
// token is permanently dead (app uninstalled, permissions revoked) — keeping it
// would make every later notification pay for a doomed send.
function tokensToDrop(messages, tickets) {
  if (!Array.isArray(tickets)) return [];
  return messages
    .filter((m, i) => tickets[i]?.details?.error === 'DeviceNotRegistered')
    .map((m) => m.to);
}

// The device-store update for a register-push call: set, replace, or clear
// (token === null) the calling device's token. Returns null when nothing changes
// so the caller can skip the disk write.
function withPushToken(devices, deviceId, token) {
  const next = token === null ? undefined : token;
  const i = (devices || []).findIndex((d) => d.id === deviceId);
  if (i < 0 || devices[i].pushToken === next) return null;
  const out = devices.slice();
  out[i] = { ...out[i] };
  if (next === undefined) delete out[i].pushToken; else out[i].pushToken = next;
  return out;
}

module.exports = { EXPO_PUSH_URL, isExpoPushToken, buildPushMessages, tokensToDrop, withPushToken };
