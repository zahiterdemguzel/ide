// Sideload an .apk the phone pulled from the desktop by handing it to Android's
// package installer. Getting the (large) file onto the phone is the hard part:
//
//  1. HTTP download (preferred). The desktop serves the file on its LAN; the phone
//     streams it straight to disk with downloadAsync — no giant JS string, any size.
//     This is the ONLY path that works in Expo Go (its file-system `next` API, which
//     could stream a socket transfer to disk, is stubbed there). Needs the phone on
//     the same network as the desktop, which Expo Go always is.
//  2. Socket stream (fallback, built app only). Off-LAN there's no HTTP route, so we
//     pull the bytes over the relay socket in ranges (read-asset-chunk) and write
//     them to disk with the `next` File API. Reassembling as one base64 string would
//     overflow Hermes' string cap, so we decode each chunk to bytes as it arrives.
//
// Then the file is wrapped in a content:// URI (a raw file:// path is rejected on
// modern Android) and opened with an ACTION_VIEW intent typed as an APK. Android
// only: iOS has no sideload path. The installer will only run if the host app is an
// allowed install source, so a blocked launch sends the user to that setting.
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { isRunningInExpoGo } from 'expo';

const APK_MIME = 'application/vnd.android.package-archive';
// Divisible by 3 so base64 slices land on byte boundaries; ~8MB base64 per frame,
// under the relay's 16MB cap.
const CHUNK = 6 * 1024 * 1024;
// How long to wait for the HTTP download to produce its first byte before deciding
// the phone can't reach the desktop's LAN and falling back to the socket.
const HTTP_FIRST_BYTE_MS = 12000;

export const isApk = (name: string) => name.toLowerCase().endsWith('.apk');

export type Req = <T = any>(ch: string, args?: any) => Promise<T>;

// Thrown with a message meant for the user (shown verbatim in the error dialog).
class InstallError extends Error {}

async function launchInstaller(fileUri: string) {
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: APK_MIME,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION — the installer runs in another process
    });
  } catch (e: any) {
    // The commonest reason the intent won't launch is that this app isn't yet an
    // allowed install source — send the user straight to that setting so they can
    // enable it and tap the APK again. (In Expo Go the source is Expo Go itself.)
    await IntentLauncher.startActivityAsync('android.settings.MANAGE_UNKNOWN_APP_SOURCES').catch(() => {});
    throw new InstallError(`Android wouldn't open the installer (${e?.message ?? 'no handler'}). Allow this app to install unknown apps in the settings screen that just opened, then tap the APK again.`);
  }
}

// Downloads to `dest` and verifies the whole file arrived (a wrong size means an
// error body or a truncated transfer, not an installable APK). Returns false — so
// the caller can fall back — only when the phone can't reach the URL at all: either
// no byte arrives within HTTP_FIRST_BYTE_MS, or the connection is refused outright.
// A reachable-but-wrong response throws, because the socket fallback would hit the
// same broken file.
async function downloadOverHttp(url: string, dest: string, expectedSize: number): Promise<boolean> {
  await FileSystem.deleteAsync(dest, { idempotent: true });
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const task = FileSystem.createDownloadResumable(url, dest, {}, (p) => {
    if (p.totalBytesWritten > 0 && timer) { started = true; clearTimeout(timer); timer = undefined; }
  });
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { if (!started) reject(new Error('unreachable')); }, HTTP_FIRST_BYTE_MS);
  });

  let res: FileSystem.FileSystemDownloadResult | undefined;
  try {
    res = await Promise.race([task.downloadAsync(), watchdog]);
  } catch {
    await task.cancelAsync().catch(() => {});
    return false; // never connected — try the socket instead
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || res.status < 200 || res.status >= 300) {
    throw new InstallError(`The desktop couldn't serve the APK (HTTP ${res?.status ?? 'error'}).`);
  }
  const info = await FileSystem.getInfoAsync(dest, { size: true });
  if (!info.exists || (expectedSize > 0 && info.size !== expectedSize)) {
    throw new InstallError(`The download was incomplete (${info.exists ? info.size : 0} of ${expectedSize} bytes).`);
  }
  return true;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64LOOKUP = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function base64ToBytes(b64: string): Uint8Array {
  const len = b64.length;
  let pad = 0;
  if (len && b64[len - 1] === '=') pad++;
  if (len > 1 && b64[len - 2] === '=') pad++;
  const out = new Uint8Array((len >> 2) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const n = (B64LOOKUP[b64.charCodeAt(i)] << 18) | (B64LOOKUP[b64.charCodeAt(i + 1)] << 12)
      | (B64LOOKUP[b64.charCodeAt(i + 2)] << 6) | B64LOOKUP[b64.charCodeAt(i + 3)];
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

async function streamOverSocket(req: Req, rel: string, dest: string): Promise<void> {
  if (isRunningInExpoGo()) {
    throw new InstallError('Sideloading this APK needs the phone on the same Wi-Fi as the desktop — Expo Go can only install over the local network.');
  }
  // Pull the file a range at a time and lay each decoded chunk into one preallocated
  // byte array — held as bytes, never as a base64 string (that's the cap we're
  // dodging) — then write it to disk in a single `next` File call. The legacy write
  // API takes only a whole string; the `next` write takes bytes but overwrites, so
  // one buffered write is simpler than streaming and safe for a phone-sized APK.
  const { File } = require('expo-file-system/next');
  let full: Uint8Array | null = null;
  let size = 0;
  let offset = 0;
  do {
    const r: any = await req('read-asset-chunk', { file: rel, offset, length: CHUNK });
    if (!r?.ok) throw new InstallError(r?.error ?? 'Could not read the file.');
    size = r.size;
    if (!full) full = new Uint8Array(size);
    if (!r.base64) break; // short read at EOF
    const bytes = base64ToBytes(r.base64);
    full.set(bytes, offset);
    offset += bytes.length;
  } while (offset < size);

  const file = new File(dest);
  if (file.exists) file.delete();
  file.create();
  file.write(full ?? new Uint8Array(0));
}

export async function installApk(req: Req, rel: string, name: string) {
  const dest = `${FileSystem.cacheDirectory}${name}`;
  const info: any = await req('apk-http-url', rel);
  const size: number = info?.ok && typeof info.size === 'number' ? info.size : 0;
  const urls: string[] = info?.ok && Array.isArray(info.urls) ? info.urls : [];

  // Try each LAN address the desktop offered; the phone shares a subnet with at most
  // one of them. A reachable-but-broken server throws out of downloadOverHttp; only
  // an unreachable address returns false and lets us try the next.
  for (const url of urls) {
    if (await downloadOverHttp(url, dest, size)) return launchInstaller(dest);
  }
  // None reachable — pull the bytes over the socket instead.
  await streamOverSocket(req, rel, dest);
  return launchInstaller(dest);
}
