// Hand an .apk the phone pulled from the desktop to Android's package installer.
// The bytes arrive base64 over the socket (read-asset), so we spill them to a cache
// file, wrap it in a content:// URI (a raw file:// path is rejected on modern
// Android), and fire an ACTION_VIEW intent typed as an APK — which is exactly what
// Android resolves to its installer UI. Android only: iOS has no sideload path.
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';

const APK_MIME = 'application/vnd.android.package-archive';

export const isApk = (name: string) => name.toLowerCase().endsWith('.apk');

export async function installApk(base64: string, name: string) {
  const dest = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 });
  const contentUri = await FileSystem.getContentUriAsync(dest);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: APK_MIME,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION — the installer runs in another process
  });
}
