// Pairing QR parsing + credential storage. The desktop QR encodes
//   ide://pair?v=1&host=<lanIP>&port=<p>&relay=<origin>&room=<id>&tk=<token>
// and carries both ways to reach the desktop, because at scan time neither end
// knows which will work. After a successful pair the server issues a long-lived
// device token, kept in SecureStore with both endpoints so the app reconnects
// without rescanning — from the same Wi-Fi or from anywhere.

import * as SecureStore from 'expo-secure-store';
import { DEFAULT_RELAY_URL } from './config';

const KEY_TOKEN = 'ide.deviceToken';
const KEY_URL = 'ide.serverUrl'; // legacy: a bare LAN ws:// URL from before the relay
const KEY_ENDPOINTS = 'ide.endpoints';

// Where the desktop can be reached. Either may be missing: an old paired phone
// has only `lan`, and a desktop with no LAN address of its own has only `relay`.
export type Endpoints = { lan?: string; relay?: string };
export type PairInfo = Endpoints & { pairToken: string };

export function parsePairUrl(data: string): PairInfo | null {
  try {
    // URL polyfills disagree on custom schemes; parse the query manually.
    const m = data.match(/^ide:\/\/pair\?(.+)$/);
    if (!m) return null;
    const params = new Map(m[1].split('&').map((kv) => {
      const [k, ...v] = kv.split('=');
      return [k, decodeURIComponent(v.join('='))] as const;
    }));
    const pairToken = params.get('tk');
    if (!pairToken) return null;

    const host = params.get('host');
    const port = params.get('port');
    const room = params.get('room');
    const relay = params.get('relay') || DEFAULT_RELAY_URL;

    const endpoints: Endpoints = {};
    if (host && port) endpoints.lan = `ws://${host}:${port}`;
    if (room) endpoints.relay = relayWsUrl(relay, room);
    if (!endpoints.lan && !endpoints.relay) return null;

    return { ...endpoints, pairToken };
  } catch {
    return null;
  }
}

// https://relay.example → wss://relay.example/?role=mobile&room=<id>
export function relayWsUrl(relayUrl: string, room: string): string {
  const scheme = relayUrl.startsWith('http://') ? 'ws://' : 'wss://';
  const origin = relayUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${scheme}${origin}/?role=mobile&room=${encodeURIComponent(room)}`;
}

// The order the app dials in: the LAN address first, because when it answers it
// is faster than the relay and does not depend on the relay being up. The relay
// is the fallback, and the only route when the phone is off the desktop's network.
export const dialOrder = (e: Endpoints): string[] => [e.lan, e.relay].filter(Boolean) as string[];

export async function saveCredentials(endpoints: Endpoints, deviceToken: string) {
  await SecureStore.setItemAsync(KEY_ENDPOINTS, JSON.stringify(endpoints));
  await SecureStore.setItemAsync(KEY_TOKEN, deviceToken);
}

export async function loadCredentials(): Promise<{ endpoints: Endpoints; deviceToken: string } | null> {
  const deviceToken = await SecureStore.getItemAsync(KEY_TOKEN);
  if (!deviceToken) return null;

  const stored = await SecureStore.getItemAsync(KEY_ENDPOINTS);
  if (stored) {
    try { return { endpoints: JSON.parse(stored) as Endpoints, deviceToken }; } catch {}
  }
  // Paired before the relay existed: all we have is the LAN URL. It still works
  // on that network, and re-pairing picks up a room.
  const legacy = await SecureStore.getItemAsync(KEY_URL);
  return legacy ? { endpoints: { lan: legacy }, deviceToken } : null;
}

export async function clearCredentials() {
  await SecureStore.deleteItemAsync(KEY_ENDPOINTS);
  await SecureStore.deleteItemAsync(KEY_URL);
  await SecureStore.deleteItemAsync(KEY_TOKEN);
}
