// Pairing QR parsing + credential storage. The desktop QR encodes
//   ide://pair?v=1&relay=<origin>&room=<id>&tk=<token>
// The desktop is reached through the cloud relay, keyed by its room. After a
// successful pair the server issues a long-lived device token, kept in SecureStore
// with the relay endpoint so the app reconnects without rescanning, from anywhere.

import * as SecureStore from 'expo-secure-store';
import { DEFAULT_RELAY_URL } from './config';
import { storageKey } from './storage';

const KEY_TOKEN = storageKey('deviceToken');
const KEY_URL = storageKey('serverUrl'); // legacy: a bare LAN ws:// URL from before the relay
const KEY_ENDPOINTS = storageKey('endpoints');

// Where the desktop can be reached: its relay socket URL (role=mobile&room=…).
export type Endpoints = { relay?: string };
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
    const room = params.get('room');
    if (!pairToken || !room) return null;

    const relay = params.get('relay') || DEFAULT_RELAY_URL;
    return { relay: relayWsUrl(relay, room), pairToken };
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

export async function saveCredentials(endpoints: Endpoints, deviceToken: string) {
  await SecureStore.setItemAsync(KEY_ENDPOINTS, JSON.stringify(endpoints));
  await SecureStore.setItemAsync(KEY_TOKEN, deviceToken);
}

export async function loadCredentials(): Promise<{ endpoints: Endpoints; deviceToken: string } | null> {
  const deviceToken = await SecureStore.getItemAsync(KEY_TOKEN);
  if (!deviceToken) return null;

  const stored = await SecureStore.getItemAsync(KEY_ENDPOINTS);
  if (stored) {
    try {
      const endpoints = JSON.parse(stored) as Endpoints;
      if (endpoints.relay) return { endpoints, deviceToken };
    } catch {}
  }
  // Paired before the relay existed, or against the removed LAN transport: nothing
  // we can still reach. Re-pairing picks up a relay room.
  return null;
}

export async function clearCredentials() {
  await SecureStore.deleteItemAsync(KEY_ENDPOINTS);
  await SecureStore.deleteItemAsync(KEY_URL);
  await SecureStore.deleteItemAsync(KEY_TOKEN);
}
