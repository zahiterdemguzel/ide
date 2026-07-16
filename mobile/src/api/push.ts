// OS push notifications (Expo push service). The app deliberately holds no
// background socket (battery — see connection.ts), so a session finishing while
// the phone sleeps can only reach it over the platform push channel (FCM/APNs via
// Expo). The desktop sends the pushes (src/main/push.js); this side registers the
// token and turns a notification tap into "open that session's chat".

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { Connection } from './connection';

// While the app is open the ws pushes already update every screen live — a system
// banner on top of that is noise, so foreground notifications are silenced.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Getting a push token needs an EAS project id (app.json extra.eas.projectId,
// stamped by `eas init`). Without one — or on a simulator, or with permission
// denied — push simply stays off; nothing else depends on it.
function projectId(): string | undefined {
  return (Constants as any)?.easConfig?.projectId
    ?? (Constants.expoConfig as any)?.extra?.eas?.projectId;
}

let cachedToken: string | null | undefined; // undefined = not yet asked

async function getPushToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = null;
  try {
    if (!Device.isDevice) return null;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('sessions', {
        name: 'Claude sessions',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;
    const id = projectId();
    if (!id) return null;
    cachedToken = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch {
    cachedToken = null; // Expo Go without push support, or no Google services — fine
  }
  return cachedToken;
}

// Called whenever a connection reaches ready: hand the desktop this device's push
// token. Idempotent (the desktop skips the write when the token is unchanged), and
// a failure is silent — push is an extra, never a blocker.
export async function registerPush(conn: Connection): Promise<void> {
  const token = await getPushToken();
  if (!token || conn.state !== 'ready') return;
  await conn.req('register-push', { token }).catch(() => {});
}

export type NotificationTap = { sessionId: string };

// The session id a tapped notification asks to open, both for taps while the app
// is alive and for the tap that cold-started it. `handled` keys off the response
// identifier so the cold-start response isn't replayed on every listener re-mount.
let handledId: string | null = null;

function tapOf(resp: Notifications.NotificationResponse | null): NotificationTap | null {
  if (!resp || resp.notification.request.identifier === handledId) return null;
  const sid = (resp.notification.request.content.data as any)?.sessionId;
  if (typeof sid !== 'string' || !sid) return null;
  handledId = resp.notification.request.identifier;
  return { sessionId: sid };
}

export function onNotificationTap(fn: (tap: NotificationTap) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const tap = tapOf(resp);
    if (tap) fn(tap);
  });
  // The tap that launched the app fired before any listener existed.
  Notifications.getLastNotificationResponseAsync().then((resp) => {
    const tap = tapOf(resp);
    if (tap) fn(tap);
  }).catch(() => {});
  return () => sub.remove();
}
