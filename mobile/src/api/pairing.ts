// Pairing QR parsing + credential storage. The desktop QR encodes
// ide://pair?v=1&host=<lanIP>&port=<p>&tk=<singleUseToken>. After a successful
// pair the server issues a long-lived device token, kept in SecureStore along
// with the last known host so the app can reconnect without rescanning.

import * as SecureStore from 'expo-secure-store';

const KEY_TOKEN = 'ide.deviceToken';
const KEY_URL = 'ide.serverUrl';

export type PairInfo = { host: string; port: string; pairToken: string };

export function parsePairUrl(data: string): PairInfo | null {
  try {
    // URL polyfills disagree on custom schemes; parse the query manually.
    const m = data.match(/^ide:\/\/pair\?(.+)$/);
    if (!m) return null;
    const params = new Map(m[1].split('&').map((kv) => {
      const [k, ...v] = kv.split('=');
      return [k, decodeURIComponent(v.join('='))] as const;
    }));
    const host = params.get('host');
    const port = params.get('port');
    const pairToken = params.get('tk');
    if (!host || !port || !pairToken) return null;
    return { host, port, pairToken };
  } catch {
    return null;
  }
}

export const wsUrl = (host: string, port: string) => `ws://${host}:${port}`;

export async function saveCredentials(url: string, deviceToken: string) {
  await SecureStore.setItemAsync(KEY_URL, url);
  await SecureStore.setItemAsync(KEY_TOKEN, deviceToken);
}

export async function loadCredentials(): Promise<{ url: string; deviceToken: string } | null> {
  const url = await SecureStore.getItemAsync(KEY_URL);
  const deviceToken = await SecureStore.getItemAsync(KEY_TOKEN);
  return url && deviceToken ? { url, deviceToken } : null;
}

export async function clearCredentials() {
  await SecureStore.deleteItemAsync(KEY_URL);
  await SecureStore.deleteItemAsync(KEY_TOKEN);
}
