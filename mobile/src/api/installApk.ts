// Sideload an .apk the phone pulled from the desktop by handing it to Android's
// package installer. Getting the (large) file onto the phone is the hard part:
//
//  1. LAN HTTP download (fastest). The desktop serves the file on its LAN; the phone
//     streams it straight to disk with downloadAsync — no giant JS string, any size.
//     Needs the phone on the same network AND the desktop's firewall to allow the
//     inbound connection — Windows blocks inbound Node servers by default, so this
//     often never answers.
//  2. Relay HTTP download. The phone opens a port-forward to the same apk-server
//     through the relay (fwd-open → /p/... URL) and downloads over that. Works
//     off-LAN and through firewalls (the desktop's relay connection is outbound),
//     and still streams to disk, so it also works in Expo Go.
//  3. Socket stream (last resort, built app only — the file-system `next` API it
//     needs is stubbed in Expo Go). Pulls the bytes over the relay socket in ranges
//     (read-asset-chunk) and writes them to disk with the `next` File API.
//     Reassembling as one base64 string would overflow Hermes' string cap, so we
//     decode each chunk to bytes as it arrives.
//
// Then the file is wrapped in a content:// URI (a raw file:// path is rejected on
// modern Android) and opened with an ACTION_VIEW intent typed as an APK. Android
// only: iOS has no sideload path. The installer will only run if the host app is an
// allowed install source, so a blocked launch sends the user to that setting.
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';
import { isRunningInExpoGo } from 'expo';

const APK_MIME = 'application/vnd.android.package-archive';
// Divisible by 3 so base64 slices land on byte boundaries; ~4MB base64 per frame,
// under the relay's 16MB cap. Kept modest because a frame crosses the relay in one
// piece — the smaller it is, the sooner each chunk request completes.
const CHUNK = 3 * 1024 * 1024;
// A chunk's response is multi-MB and crosses the relay; the connection's default
// 20s request deadline declares the socket dead mid-transfer (and closes it, which
// was the "waits then reconnects" failure). Give each chunk a slow-link budget.
const CHUNK_TIMEOUT_MS = 120000;
// How long to wait for a candidate URL to produce its first byte before moving on.
// A dev box offers several LAN addresses (Wi-Fi + VirtualBox/Hyper-V/VPN adapters)
// and most are dead ends, so this must be short — the old 12s made a firewalled
// desktop look like a hang (4 adapters ≈ a minute of silence before any fallback).
const HTTP_FIRST_BYTE_MS = 5000;
// The relay URL's server is already connected, so granting it longer is safe — a
// slow first byte there is queueing, not unreachability.
const RELAY_FIRST_BYTE_MS = 15000;
// fwd-open normally answers (fwd-ok/fwd-err) fast; a desktop that never replies
// must not hang the install forever.
const FWD_OPEN_TIMEOUT_MS = 10000;

export const isApk = (name: string) => name.toLowerCase().endsWith('.apk');

export type Req = <T = any>(ch: string, args?: any, opts?: { timeoutMs?: number }) => Promise<T>;
export type InstallConn = {
  req: Req;
  forwardPort?: (port: number, path?: string) => Promise<string>;
  closeForward?: (port: number) => void;
  // Current socket state + change subscription (Connection's own shape). The LAN
  // probe phase can coincide with a socket drop — Android tearing down connections
  // while it prods a dead subnet — and the reconnect lands within ~100ms, so each
  // fallback step waits for `ready` instead of dying on 'not connected'.
  state?: () => string;
  onState?: (fn: (s: string) => void) => () => void;
};

// Resolve when the socket is ready; give the reconnect this long before failing.
const RECONNECT_WAIT_MS = 15000;
function whenReady(conn: InstallConn): Promise<void> {
  if (!conn.state || !conn.onState || conn.state() === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new InstallError('Lost the connection to the desktop and it did not come back.'));
    }, RECONNECT_WAIT_MS);
    const off = conn.onState!((s) => {
      if (s !== 'ready') return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

// Thrown with a message meant for the user (shown verbatim in the error dialog).
class InstallError extends Error {}

// Every step of the install narrates to the Metro/Expo console — the flow spans
// three transports and takes tens of seconds, and a silent failure mid-way is
// undebuggable from the desktop's log alone.
const log = (...args: unknown[]) => console.log('[installApk]', ...args);
const warn = (...args: unknown[]) => console.warn('[installApk]', ...args);

async function launchInstaller(fileUri: string) {
  const stat = await FileSystem.getInfoAsync(fileUri, { size: true });
  if (!stat.exists) throw new InstallError(`The downloaded file vanished before install (${fileUri}).`);
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  log(`launching installer: ${contentUri} (${stat.size} bytes)`);
  // ACTION_VIEW typed as an APK is the canonical route; ACTION_INSTALL_PACKAGE is
  // the older dedicated one — on some Android builds VIEW resolves to nothing (or
  // to a viewer that quietly does nothing), so try both before giving up.
  const attempts: [string, Record<string, unknown>][] = [
    ['android.intent.action.VIEW', { data: contentUri, type: APK_MIME, flags: 1 }],
    ['android.intent.action.INSTALL_PACKAGE', { data: contentUri, flags: 1 }],
  ];
  let lastErr: any;
  for (const [action, params] of attempts) {
    try {
      const res = await IntentLauncher.startActivityAsync(action, params);
      log(`${action} returned resultCode ${res.resultCode}`);
      return;
    } catch (e: any) {
      lastErr = e;
      warn(`${action} failed: ${e?.message ?? e}`);
    }
  }
  // The commonest reason neither intent launches is that this app isn't yet an
  // allowed install source — send the user straight to that setting so they can
  // enable it and tap the APK again. (In Expo Go the source is Expo Go itself.)
  // With a `package:` data URI Android opens THIS app's toggle instead of the
  // full unknown-sources list.
  const pkg = isRunningInExpoGo() ? 'host.exp.exponent' : Constants.expoConfig?.android?.package;
  await IntentLauncher.startActivityAsync(
    'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    pkg ? { data: `package:${pkg}` } : {},
  ).catch(() => {});
  throw new InstallError(`Android wouldn't open the installer (${lastErr?.message ?? 'no handler'}). Allow this app to install unknown apps in the settings screen that just opened, then tap the APK again.`);
}

// Downloads to `dest` and verifies the whole file arrived (a wrong size means an
// error body or a truncated transfer, not an installable APK). Returns false — so
// the caller can fall back — only when the phone can't reach the URL at all: either
// no byte arrives within HTTP_FIRST_BYTE_MS, or the connection is refused outright.
// A reachable-but-wrong response throws, because the socket fallback would hit the
// same broken file.
async function downloadOverHttp(url: string, dest: string, expectedSize: number, firstByteMs = HTTP_FIRST_BYTE_MS): Promise<boolean> {
  await FileSystem.deleteAsync(dest, { idempotent: true });
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // x-ide-direct makes the relay's port-forward proxy accept the URL token in one
  // round trip instead of the browser cookie handshake (downloadAsync can't be
  // trusted to carry a Set-Cookie across a 302). The LAN apk-server ignores it.
  const task = FileSystem.createDownloadResumable(url, dest, { headers: { 'x-ide-direct': '1' } }, (p) => {
    if (p.totalBytesWritten > 0 && timer) { started = true; clearTimeout(timer); timer = undefined; }
  });
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { if (!started) reject(new Error('unreachable')); }, firstByteMs);
  });

  let res: FileSystem.FileSystemDownloadResult | undefined;
  try {
    res = await Promise.race([task.downloadAsync(), watchdog]);
  } catch (e: any) {
    warn(`download from ${url} never connected (${e?.message ?? e}) — moving on`);
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

async function streamOverSocket(conn: InstallConn, rel: string, dest: string): Promise<void> {
  const { req } = conn;
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
    let r: any;
    try {
      r = await req('read-asset-chunk', { file: rel, offset, length: CHUNK }, { timeoutMs: CHUNK_TIMEOUT_MS });
    } catch (e: any) {
      // Socket dropped mid-transfer; the reconnect lands within moments. Ranges are
      // absolute offsets, so waiting for ready and re-asking loses nothing.
      warn(`chunk at ${offset} failed (${e?.message ?? e}) — waiting for reconnect and retrying`);
      await whenReady(conn);
      r = await req('read-asset-chunk', { file: rel, offset, length: CHUNK }, { timeoutMs: CHUNK_TIMEOUT_MS });
    }
    if (!r?.ok) throw new InstallError(r?.error ?? 'Could not read the file.');
    size = r.size;
    if (!full) full = new Uint8Array(size);
    if (!r.base64) break; // short read at EOF
    const bytes = base64ToBytes(r.base64);
    full.set(bytes, offset);
    offset += bytes.length;
    log(`socket stream: ${offset}/${size} bytes`);
  } while (offset < size);

  const file = new File(dest);
  if (file.exists) file.delete();
  file.create();
  file.write(full ?? new Uint8Array(0));
}

export async function installApk(conn: InstallConn, rel: string, name: string) {
  const { req } = conn;
  // Spaces or exotic characters in the repo filename would land unescaped in the
  // file:// URI and can break the content-URI bridge to the installer.
  const safeName = name.replace(/[^\w.-]+/g, '_');
  const dest = `${FileSystem.cacheDirectory}${safeName}`;
  log(`installing ${rel}`);
  const info: any = await req('apk-http-url', rel);
  if (info && info.ok === false) throw new InstallError(info.error ?? 'The desktop could not publish the APK.');
  const size: number = info?.ok && typeof info.size === 'number' ? info.size : 0;
  const urls: string[] = info?.ok && Array.isArray(info.urls) ? info.urls : [];
  log(`desktop published ${size} bytes; ${urls.length} LAN url(s), relay port ${info?.port ?? 'n/a'}`);

  try {
    // Try each LAN address the desktop offered; the phone shares a subnet with at
    // most one of them. A reachable-but-broken server throws out of downloadOverHttp;
    // only an unreachable address returns false and lets us try the next.
    for (const url of urls) {
      log(`trying LAN download: ${url}`);
      if (await downloadOverHttp(url, dest, size)) {
        log('LAN download complete — launching installer');
        return await launchInstaller(dest);
      }
    }

    // No LAN address answered (off-LAN, or the desktop's firewall eats inbound
    // connections — Windows blocks Node servers by default). Reach the same server
    // through the relay port-forward instead: it rides the desktop's outbound relay
    // socket, so nothing can block it, and it still streams to disk.
    if (info?.port && info?.path && conn.forwardPort) {
      try {
        await whenReady(conn);
        log(`no LAN url answered — opening relay forward to port ${info.port}`);
        const relayUrl = await Promise.race([
          conn.forwardPort(info.port, info.path),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fwd-open timed out')), FWD_OPEN_TIMEOUT_MS)),
        ]);
        log(`relay forward open — downloading ${relayUrl}`);
        try {
          if (await downloadOverHttp(relayUrl, dest, size, RELAY_FIRST_BYTE_MS)) {
            log('relay download complete — launching installer');
            return await launchInstaller(dest);
          }
        } finally {
          conn.closeForward?.(info.port);
        }
      } catch (e: any) {
        if (e instanceof InstallError) throw e;
        // fwd-open refused (old desktop) or timed out — fall through to the socket.
        warn(`relay forward failed (${e?.message ?? e}) — falling back to socket stream`);
      }
    } else if (!conn.forwardPort) {
      warn('connection has no forwardPort — skipping the relay path');
    }

    // Last resort — pull the bytes over the relay socket in ranges.
    await whenReady(conn);
    log('streaming over the relay socket in chunks');
    await streamOverSocket(conn, rel, dest);
    log('socket stream complete — launching installer');
    return await launchInstaller(dest);
  } catch (e: any) {
    warn(`install failed: ${e?.message ?? e}`);
    throw e;
  }
}
