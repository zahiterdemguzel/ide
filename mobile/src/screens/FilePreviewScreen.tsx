// In-app preview for files that aren't text: images, SVG icons and PDFs. A pushed
// root-stack screen (`FilePreview`), opened from the Files tab, a chat link or the
// text viewer when the file turns out to be one of those kinds.
//
// The file is downloaded once (the same LAN → relay → socket pipe an APK install
// uses), then shown in a WebView page built by `file-ops.js` — pinch-zoomable on
// both platforms. The downloaded copy also backs the bar's actions: open it in
// another app, save it onto the phone, or share it. Those stay available when the
// preview itself fails (no internet for pdf.js, a format the WebView can't decode,
// a file too big to preview), so a file is never a dead end.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { WebView } from 'react-native-webview';
import { useConnection } from '../api/context';
import { downloadRepoFile, openInOtherApp, saveToPhone, shareLocalFile } from '../api/fileActions';
import FileIcon from '../components/FileIcon';
import { Button, ErrorState, LoadingState } from '../components/ui';
import { ActionSheet, type SheetAction } from '../components/PromptDialog';
import { ConnectionBanner, showToast } from '../components/feedback';
import { showError, errorText } from '../components/ErrorDialog';
import {
  MAX_PREVIEW_BYTES, baseName, formatBytes, imagePreviewHtml, parentPath, pdfPreviewHtml, previewKindFor,
} from '../lib/file-ops';
import { color, inset, radius } from '../theme';

export type FilePreviewParams = { path: string };

type Loaded = { localUri: string; size: number; html: string | null };

export default function FilePreviewScreen({ route, navigation }: any) {
  const { path } = route.params as FilePreviewParams;
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const name = baseName(path);
  const dir = parentPath(path);
  const kind = previewKindFor(name);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<SheetAction[] | null>(null);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoadError(null);
    setRenderError(null);
    setLoaded(null);
    try {
      const localUri = await downloadRepoFile(conn, path, name);
      const info = await FileSystem.getInfoAsync(localUri, { size: true });
      const size = info.exists ? info.size : 0;
      if (!kind || size > MAX_PREVIEW_BYTES) {
        setLoaded({ localUri, size, html: null });
        return;
      }
      const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
      const html = kind === 'pdf' ? pdfPreviewHtml({ base64 }) : imagePreviewHtml({ kind, base64, name });
      setLoaded({ localUri, size, html });
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [conn, path, name, kind]);

  useEffect(() => { load(); }, [load]);

  // The desktop opened another folder: this repo-relative path means something
  // else now, so the preview is stale.
  useEffect(() => conn?.on('folder-changed', () => navigation.goBack()), [conn, navigation]);

  // Every action works on the downloaded copy; busy covers the hand-off to another
  // app or the folder picker, so a double tap doesn't fire twice.
  const runAction = async (label: string, action: (localUri: string) => Promise<void>) => {
    if (!loaded || busy) return;
    setBusy(true);
    try {
      await action(loaded.localUri);
    } catch (err) {
      showError(label, `${name}: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const openElsewhere = (anyApp: boolean) => runAction('Open file', (uri) => openInOtherApp(uri, name, { anyApp }));
  const share = () => runAction('Share file', (uri) => shareLocalFile(uri, name));
  const save = (chooseFolder: boolean) => runAction('Save to phone', async (uri) => {
    const result = await saveToPhone(uri, name, { chooseFolder });
    if (result.saved) showToast({ message: `Saved ${name} to ${result.where}`, tone: 'success' });
  });

  const moreActions: SheetAction[] = useMemo(() => [
    ...(Platform.OS === 'android'
      ? [
        { label: 'Open in another app', icon: 'open-outline', onPress: () => openElsewhere(false) },
        { label: 'Open with any app…', icon: 'apps-outline', onPress: () => openElsewhere(true) },
        { label: 'Save to phone', icon: 'download-outline', onPress: () => save(false) },
        { label: 'Save to folder…', icon: 'folder-open-outline', onPress: () => save(true) },
      ]
      : [{ label: 'Open in another app', icon: 'open-outline', onPress: () => openElsewhere(false) }]),
    { label: 'Share…', icon: 'share-outline', onPress: share },
    ...(kind === 'svg'
      ? [{ label: 'View source', icon: 'code-slash-outline', onPress: () => navigation.navigate('FileViewer', { path }) }]
      : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [loaded, busy, kind, path]);

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'error') setRenderError(String(msg.message));
      if (msg.type === 'ready' && typeof msg.pages === 'number') setPages(msg.pages);
    } catch {
      // Not one of the page's messages.
    }
  };

  const subtitle = [dir, loaded ? formatBytes(loaded.size) : '', pages ? `${pages} page${pages === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' · ');

  const fallback = (title: string, message: string) => (
    <View style={styles.fallback}>
      <Ionicons name="document-outline" size={40} color={color.muted} />
      <Text style={styles.fallbackTitle}>{title}</Text>
      <Text style={styles.fallbackMessage}>{message}</Text>
      <View style={styles.fallbackActions}>
        <Button label="Open in another app" icon="open-outline" onPress={() => openElsewhere(false)} disabled={busy} />
        <Button
          label={Platform.OS === 'android' ? 'Save to phone' : 'Share / Save to Files'}
          icon="download-outline"
          tone="secondary"
          onPress={() => (Platform.OS === 'android' ? save(false) : share())}
          disabled={busy}
        />
      </View>
    </View>
  );

  let body: React.ReactNode;
  if (loadError) body = <ErrorState title={`Couldn't download ${name}`} message={loadError} onRetry={load} />;
  else if (!loaded) body = <LoadingState label={`Downloading ${name}…`} />;
  else if (!loaded.html) {
    body = fallback(
      kind ? 'Too large to preview here' : 'No preview for this file',
      kind ? `${formatBytes(loaded.size)} is more than the phone previews in-app.` : 'Open it in another app or save it to the phone.',
    );
  } else if (renderError) body = fallback('Couldn’t show this file', renderError);
  else {
    body = (
      <WebView
        style={styles.web}
        source={{ html: loaded.html }}
        originWhitelist={['*']}
        onMessage={onMessage}
        // Pinch-zoom: Android needs the built-in zoom on (without its +/- buttons).
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        scalesPageToFit
        javaScriptEnabled={kind === 'pdf' || true}
        onError={(e) => setRenderError(e.nativeEvent.description || 'The preview failed to load.')}
        accessibilityLabel={`Preview of ${name}`}
      />
    );
  }

  return (
    <View style={styles.fill}>
      <View style={[styles.bar, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={color.accent} />
        </Pressable>
        <FileIcon name={name} size={16} />
        <View style={styles.barTitle}>
          <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
          {!!subtitle && <Text style={styles.filePath} numberOfLines={1}>{subtitle}</Text>}
        </View>
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={() => (Platform.OS === 'android' ? save(false) : share())}
          disabled={!loaded || busy}
          accessibilityRole="button"
          accessibilityLabel={Platform.OS === 'android' ? `Save ${name} to phone` : `Share ${name}`}
        >
          <Ionicons
            name={Platform.OS === 'android' ? 'download-outline' : 'share-outline'}
            size={20}
            color={loaded && !busy ? color.accent : color.faint}
          />
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={() => setMenu(moreActions)}
          disabled={!loaded}
          accessibilityRole="button"
          accessibilityLabel="More actions"
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={loaded ? color.accent : color.faint} />
        </Pressable>
      </View>
      <ConnectionBanner />
      {body}
      <View style={{ height: insets.bottom, backgroundColor: color.bg }} />
      <ActionSheet title={name} actions={menu} onClose={() => setMenu(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 2,
    gap: 4,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: color.raised },
  barTitle: { flex: 1, minWidth: 0 },
  fileName: { color: color.text, fontSize: 14, fontWeight: '600' },
  filePath: { color: color.faint, fontSize: 11 },
  web: { flex: 1, backgroundColor: color.bg },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  fallbackTitle: { color: color.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  fallbackMessage: { color: color.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  fallbackActions: { gap: 10, marginTop: 8, alignSelf: 'stretch' },
});
