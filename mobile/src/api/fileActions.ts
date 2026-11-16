// What the phone can do with a repo file beyond reading it as text: download it,
// open it in another app, share it, or save a copy onto the phone itself. The
// Files tab's row menu and the in-app preview (FilePreviewScreen) both call these.
//
// Every action starts with the same download (`fetchToCache` — LAN → relay forward
// → socket chunks), so a file of any size or type works the same way.
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { fetchToCache, openInOtherApp, shareLocalFile, type InstallConn } from './installApk';
import { mimeForName } from '../lib/file-ops';

// The subset of the live Connection these actions need.
type LiveConn = {
  req: (ch: string, args?: any, opts?: any) => Promise<any>;
  forwardPort?: (port: number, path?: string) => Promise<string>;
  closeForward?: (port: number) => void;
  state?: string;
  onState?: (fn: (s: string) => void) => () => void;
};

/** Adapt the app's Connection to the download pipe's interface (all transports on). */
export function fileConn(conn: LiveConn): InstallConn {
  return {
    req: (ch, args, opts) => conn.req(ch, args, opts),
    forwardPort: conn.forwardPort && ((port, path) => conn.forwardPort!(port, path)),
    closeForward: conn.closeForward && ((port) => conn.closeForward!(port)),
    state: () => conn.state ?? 'ready',
    onState: conn.onState && ((fn) => conn.onState!(fn)),
  };
}

/** Pull a repo file onto the phone (app cache) and return its file:// uri. */
export function downloadRepoFile(conn: LiveConn, rel: string, name: string): Promise<string> {
  return fetchToCache(fileConn(conn), rel, name);
}

export { openInOtherApp, shareLocalFile };

// --- Save to phone -------------------------------------------------------------
//
// Android: the Storage Access Framework. The user picks a folder once (the picker
// opens on Downloads); the grant is persisted and remembered here, so later saves
// land there without asking. A revoked grant just asks again.
// iOS has no app-writable shared folder, so the share sheet's "Save to Files" /
// "Save Image" is the save.

const SAVE_FOLDER_FILE = `${FileSystem.documentDirectory}save-folder.json`;
// The SAF write takes the whole file as one base64 string; past this the string
// would strain the JS heap, so big files go through the share sheet instead.
const MAX_SAF_SAVE_BYTES = 200 * 1024 * 1024;

async function rememberedSaveFolder(): Promise<string | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(SAVE_FOLDER_FILE);
    return JSON.parse(raw)?.uri ?? null;
  } catch {
    return null;
  }
}

async function rememberSaveFolder(uri: string | null) {
  if (uri) await FileSystem.writeAsStringAsync(SAVE_FOLDER_FILE, JSON.stringify({ uri })).catch(() => {});
  else await FileSystem.deleteAsync(SAVE_FOLDER_FILE, { idempotent: true }).catch(() => {});
}

async function pickSaveFolder(): Promise<string | null> {
  const saf = FileSystem.StorageAccessFramework;
  const downloads = saf.getUriForDirectoryInRoot('Download');
  const grant = await saf.requestDirectoryPermissionsAsync(downloads);
  if (!grant.granted) return null;
  await rememberSaveFolder(grant.directoryUri);
  return grant.directoryUri;
}

async function writeIntoFolder(folderUri: string, localUri: string, name: string): Promise<string> {
  const saf = FileSystem.StorageAccessFramework;
  const target = await saf.createFileAsync(folderUri, name, mimeForName(name));
  const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
  await saf.writeAsStringAsync(target, base64, { encoding: FileSystem.EncodingType.Base64 });
  return target;
}

// Readable folder name from a SAF tree uri (…/tree/primary%3ADownload → Download).
function folderLabel(folderUri: string): string {
  const tail = decodeURIComponent(folderUri.split('/tree/').pop() ?? '');
  return tail.split(':').pop() || 'the chosen folder';
}

export type SaveResult =
  | { saved: true; where: string }
  | { saved: false; reason: 'cancelled' | 'shared' };

/**
 * Save a downloaded file onto the phone. `chooseFolder` forces the folder picker
 * even when one is remembered ("Save to…").
 */
export async function saveToPhone(localUri: string, name: string, { chooseFolder = false } = {}): Promise<SaveResult> {
  const info = await FileSystem.getInfoAsync(localUri, { size: true });
  const tooBigForSaf = info.exists && info.size > MAX_SAF_SAVE_BYTES;
  if (Platform.OS !== 'android' || tooBigForSaf) {
    await shareLocalFile(localUri, name);
    return { saved: false, reason: 'shared' };
  }

  let folder = chooseFolder ? null : await rememberedSaveFolder();
  if (folder) {
    try {
      await writeIntoFolder(folder, localUri, name);
      return { saved: true, where: folderLabel(folder) };
    } catch {
      // The grant was revoked or the folder is gone — forget it and ask again.
      await rememberSaveFolder(null);
    }
  }
  folder = await pickSaveFolder();
  if (!folder) return { saved: false, reason: 'cancelled' };
  await writeIntoFolder(folder, localUri, name);
  return { saved: true, where: folderLabel(folder) };
}
