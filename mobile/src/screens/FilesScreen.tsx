// File browser. Mirrors the desktop explorer's list-dir / read-text / create-file /
// create-folder / rename-file / delete-file channels (repo-relative paths, {ok,...}
// results), and reuses its file icons — see FileIcon.
//
// The browser is one card of rows under a breadcrumb. Opening a file pushes the
// `FileViewer` stack screen (FileViewerScreen.tsx) over the tabs; until that route
// is registered the same viewer renders inline here instead.
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, StyleSheet, ActivityIndicator,
  ScrollView, Platform, BackHandler,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import FileIcon from '../components/FileIcon';
import ScreenHeader, { ChromeContext, NoProject } from '../components/ScreenHeader';
import { Divider, EmptyState, ErrorState, IconButton, LoadingState } from '../components/ui';
import { showError, errorText } from '../components/ErrorDialog';
import { confirmAction, haptic, showToast } from '../components/feedback';
import { ActionSheet, PromptDialog, type PromptRequest, type SheetAction } from '../components/PromptDialog';
import { FileViewer, primeFileText, type FileViewerParams } from './FileViewerScreen';
import { isApk, installApk, openBinaryFile } from '../api/installApk';
import {
  baseName, createLatestQueue, joinPath, parentPath, renamedPath, validateEntryName,
} from '../lib/file-ops';
import { alpha, color, radius, font } from '../theme';

type Entry = { name: string; dir: boolean };
type Ref = { file: string; line: number; text: string };
type Found = { files: string[]; refs: Ref[]; refsPending: boolean; refsError?: string };

const VIEWER_ROUTE = 'FileViewer';

export default function FilesScreen() {
  const { conn } = useConnection();
  const { project } = useContext(ChromeContext);
  const navigation = useNavigation<any>();
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // Only used while the root stack has no FileViewer route (see the header comment).
  const [inlineFile, setInlineFile] = useState<FileViewerParams | null>(null);

  const [menu, setMenu] = useState<{ title?: string; actions: SheetAction[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);

  // Search mirrors the desktop explorer/Ctrl+P: filenames first (search-names,
  // fast), then content hits (search-refs, git grep) streamed in below. A run
  // token drops a slow response once the query has moved on.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const searchRun = useRef(0);

  const cwdRef = useRef('');
  cwdRef.current = cwd;
  const connRef = useRef(conn);
  connRef.current = conn;

  // One listing in flight at a time, latest-wins: the tree watcher fires in bursts
  // (collapsed into one extra listing), and a folder tap made mid-listing is queued
  // rather than ignored — the old busy flag silently dropped it.
  const [listQueue] = useState(() => createLatestQueue<string>(async (rel, superseded) => {
    const c = connRef.current;
    if (!c) return;
    try {
      const r: any = await c.req('list-dir', rel);
      if (superseded()) return;
      if (r?.ok) { setCwd(rel); setEntries(r.entries); setListError(null); }
      else showError('Files', r?.error ?? 'Could not read that folder.');
    } catch (err) {
      // Socket dropped mid-request; the reconnect re-lists on focus. Only say so
      // when there's nothing on screen — a stale list beats an error over it.
      if (!superseded()) setListError(errorText(err));
    } finally {
      if (!superseded()) { setLoading(false); setRefreshing(false); }
    }
  }));

  const list = useCallback((rel: string) => listQueue.request(rel), [listQueue]);
  const goTo = useCallback((rel: string) => { setLoading(true); list(rel); }, [list]);

  // Re-list on focus, when the desktop's watcher reports the tree moved, and when
  // the project changes out from under us.
  useFocusEffect(useCallback(() => { list(cwdRef.current); }, [list]));

  useEffect(() => {
    const offTree = conn?.on('tree-changed', () => list(cwdRef.current));
    const offFolder = conn?.on('folder-changed', () => goTo(''));
    return () => { offTree?.(); offFolder?.(); };
  }, [conn, list, goTo]);

  const viewerRouteRegistered = () => {
    const root = navigation.getParent?.();
    return !!root?.getState?.()?.routeNames?.includes(VIEWER_ROUTE);
  };

  const showViewer = (params: FileViewerParams) => {
    if (viewerRouteRegistered()) navigation.navigate(VIEWER_ROUTE, params);
    else setInlineFile(params);
  };

  const openPath = async (rel: string, line?: number) => {
    if (!conn) return;
    const name = baseName(rel);
    const installConn = {
      req: (ch: string, args?: any, opts?: any) => conn.req<any>(ch, args, opts),
      forwardPort: (port: number, path?: string) => conn.forwardPort(port, path),
      closeForward: (port: number) => conn.closeForward(port),
      state: () => conn.state,
      onState: (fn: (s: string) => void) => conn.onState(fn),
    };
    setOpening(true);
    try {
      // An .apk isn't text — on Android, pull its bytes and hand it to the OS
      // package installer instead of trying to render it in the viewer.
      if (Platform.OS === 'android' && isApk(name)) {
        await installApk(installConn, rel, name).catch((err) => {
          showError('Install APK', `Could not open the installer for ${name}.\n\n${errorText(err)}`);
        });
        return;
      }
      const r: any = await conn.req('read-text', rel);
      if (!r?.ok) {
        // Not text (an image, a zip, some unknown binary): pull the file down the
        // same pipe the APK uses and let the user pick an app via the share sheet.
        await openBinaryFile(installConn, rel, name).catch((err) => {
          showError('Files', `Could not open ${name}.\n\n${errorText(err)}`);
        });
        return;
      }
      primeFileText(rel, r.text);
      showViewer({ path: rel, line });
    } catch (err) {
      showError('Files', `Could not open ${name}.\n\n${errorText(err)}`);
    } finally {
      setOpening(false);
    }
  };

  const openEntry = (e: Entry) => {
    const rel = joinPath(cwd, e.name);
    if (e.dir) return goTo(rel);
    return openPath(rel);
  };

  // --- File management: New file / New folder / Rename / Delete ---------------

  const createIn = (dir: string, kind: 'file' | 'folder') => {
    setPrompt({
      title: kind === 'file' ? 'New file' : 'New folder',
      message: dir ? `Create in ${dir}/` : 'Create at the project root',
      placeholder: kind === 'file' ? 'notes.md' : 'assets',
      confirmLabel: 'Create',
      onSubmit: async (value) => {
        const check = validateEntryName(value, { nested: true });
        if (!check.ok) return check.error;
        const rel = joinPath(dir, check.name);
        const r: any = await conn?.req(kind === 'file' ? 'create-file' : 'create-folder', rel);
        if (!r?.ok) return r?.error ?? `Could not create ${kind}.`;
        showToast({ message: `Created ${check.name}`, tone: 'success' });
        list(cwdRef.current);
        // As on the desktop, a new file opens straight away; a folder just appears.
        if (kind === 'file') openPath(r.rel ?? rel);
        return null;
      },
    });
  };

  const rename = (rel: string) => {
    const oldName = baseName(rel);
    setPrompt({
      title: 'Rename',
      message: oldName,
      initialValue: oldName,
      confirmLabel: 'Rename',
      onSubmit: async (value) => {
        const check = validateEntryName(value);
        if (!check.ok) return check.error;
        if (check.name === oldName) return null;
        const r: any = await conn?.req('rename-file', { from: rel, to: renamedPath(rel, check.name) });
        if (!r?.ok) return r?.error ?? 'Could not rename.';
        showToast({ message: `Renamed to ${check.name}`, tone: 'success' });
        list(cwdRef.current);
        return null;
      },
    });
  };

  const remove = async (rel: string, dir: boolean) => {
    const name = baseName(rel);
    const ok = await confirmAction({
      title: `Delete ${dir ? 'folder' : 'file'}?`,
      message: `“${name}”${dir ? ' and everything in it' : ''} will be moved to the desktop's trash.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const r: any = await conn?.req('delete-file', rel);
      if (!r?.ok) { showError('Delete failed', r?.error ?? `Could not delete ${name}.`); return; }
      showToast({ message: `Moved ${name} to the trash`, tone: 'success' });
      list(cwdRef.current);
    } catch (err) {
      showError('Delete failed', `Could not delete ${name}.\n\n${errorText(err)}`);
    }
  };

  const openRowMenu = (e: Entry) => {
    haptic.tap();
    const rel = joinPath(cwd, e.name);
    setMenu({
      title: rel,
      actions: [
        { label: 'Rename', icon: 'pencil-outline', onPress: () => rename(rel) },
        { label: 'Delete', icon: 'trash-outline', destructive: true, onPress: () => remove(rel, e.dir) },
      ],
    });
  };

  const openCreateMenu = () => {
    setMenu({
      title: cwd ? `In ${cwd}/` : 'At the project root',
      actions: [
        { label: 'New file', icon: 'document-outline', onPress: () => createIn(cwdRef.current, 'file') },
        { label: 'New folder', icon: 'folder-outline', onPress: () => createIn(cwdRef.current, 'folder') },
      ],
    });
  };

  // --- Search ------------------------------------------------------------------

  useEffect(() => {
    const q = query.trim();
    setSearchError(null);
    if (!q || !conn) { setFound(null); return; }
    const run = ++searchRun.current;
    const timer = setTimeout(async () => {
      try {
        const names: any = await conn.req('search-names', q);
        if (run !== searchRun.current) return;
        setFound({ files: names?.ok ? names.files : [], refs: [], refsPending: true });
      } catch (err) {
        if (run === searchRun.current) setSearchError(errorText(err));
        return;
      }
      try {
        const refs: any = await conn.req('search-refs', q);
        if (run !== searchRun.current) return;
        setFound((prev) => prev && { ...prev, refs: refs?.ok ? refs.matches : [], refsPending: false });
      } catch (err) {
        if (run !== searchRun.current) return;
        setFound((prev) => prev && { ...prev, refsPending: false, refsError: errorText(err) });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, conn, searchAttempt]);

  // Android back: climb a folder before backing out of the tab. Returning true
  // swallows the event; false passes it to the inline viewer when one is up.
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (inlineFile) return false;
      if (cwdRef.current) { goTo(parentPath(cwdRef.current)); return true; }
      return false;
    });
    return () => sub.remove();
  }, [inlineFile, goTo]));

  const closeInline = useCallback(() => setInlineFile(null), []);

  if (!project) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Files" />
        <NoProject />
      </View>
    );
  }

  if (inlineFile) {
    return (
      <FileViewer
        key={`${inlineFile.path}:${inlineFile.line ?? 0}`}
        path={inlineFile.path}
        line={inlineFile.line}
        onExit={closeInline}
        inline
      />
    );
  }

  const crumbs = cwd ? cwd.split('/') : [];
  const searching = !!query.trim();

  // Flatten the two result sections into one list: a heading row, then its hits.
  type SearchRow = { key: string; head?: string; file?: string; line?: number; snippet?: string };
  const searchRows: SearchRow[] = [];
  if (searching && found) {
    searchRows.push({ key: 'h-files', head: `Files (${found.files.length})` });
    for (const f of found.files) searchRows.push({ key: `f-${f}`, file: f });
    searchRows.push({
      key: 'h-refs',
      head: found.refsPending
        ? 'References…'
        : found.refsError ? 'References — search failed' : `References (${found.refs.length})`,
    });
    found.refs.forEach((m, i) => searchRows.push({ key: `r-${i}`, file: m.file, line: m.line, snippet: m.text }));
  }

  const renderSearch = () => {
    if (searchError) {
      return (
        <ErrorState
          title="Search failed"
          message={searchError}
          onRetry={() => setSearchAttempt((n) => n + 1)}
        />
      );
    }
    if (!found) return <LoadingState label="Searching…" />;
    return (
      <FlatList
        data={searchRows}
        keyExtractor={(r) => r.key}
        style={styles.listOuter}
        contentContainerStyle={styles.card}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) =>
          item.head ? (
            <Text style={styles.searchHead}>{item.head}</Text>
          ) : (
            <Pressable
              style={({ pressed }) => [styles.row, styles.searchRow, pressed && styles.rowPressed]}
              // A reference hit opens scrolled to, and marking, its line.
              onPress={() => openPath(item.file!, item.line)}
              accessibilityRole="button"
              accessibilityLabel={item.line ? `Open ${item.file} at line ${item.line}` : `Open ${item.file}`}
            >
              <View style={styles.rowIcon}>
                <FileIcon name={baseName(item.file!)} size={18} />
              </View>
              <View style={styles.searchBody}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.line ? `${item.file}:${item.line}` : item.file}
                </Text>
                {!!item.snippet && (
                  <Text style={styles.snippet} numberOfLines={1}>{item.snippet.trim()}</Text>
                )}
              </View>
            </Pressable>
          )
        }
      />
    );
  };

  const renderListing = () => {
    if (loading) return <LoadingState />;
    if (listError && !entries.length) {
      return <ErrorState message={listError} onRetry={() => goTo(cwdRef.current)} />;
    }
    return (
      <FlatList
        data={entries}
        keyExtractor={(e) => e.name}
        refreshing={refreshing}
        onRefresh={() => { setRefreshing(true); list(cwd); }}
        ItemSeparatorComponent={() => <Divider inset={46} />}
        style={styles.listOuter}
        // The card IS the content container, so it grows with the rows and scrolls
        // with them rather than clipping them at a fixed height.
        contentContainerStyle={entries.length ? styles.card : styles.grow}
        ListEmptyComponent={
          <EmptyState
            icon="folder-open-outline"
            title="This folder is empty"
            message="Add a file or folder here, or create one on the desktop."
            actionLabel="New file or folder"
            actionIcon="add"
            onAction={openCreateMenu}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => openEntry(item)}
            onLongPress={() => openRowMenu(item)}
            accessibilityRole="button"
            accessibilityLabel={item.dir ? `Folder ${item.name}` : item.name}
            accessibilityHint="Long-press for rename and delete"
          >
            <View style={styles.rowIcon}>
              <FileIcon name={item.name} dir={item.dir} size={18} />
            </View>
            <Text style={[styles.rowName, item.dir && styles.rowDir]} numberOfLines={1}>{item.name}</Text>
            <IconButton
              icon="ellipsis-horizontal"
              label={`More actions for ${item.name}`}
              onPress={() => openRowMenu(item)}
              size={16}
              hue={color.iconFaint}
              style={styles.rowMore}
            />
            {item.dir && <Ionicons name="chevron-forward" size={16} color={color.iconFaint} />}
          </Pressable>
        )}
      />
    );
  };

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Files">
        <View style={styles.crumbRow}>
          {/* The breadcrumb doubles as the up control — every segment is a target, so
              a dedicated back button would only repeat the second-to-last crumb. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.crumbBar}
            contentContainerStyle={styles.crumbs}
            ref={(r) => r?.scrollToEnd({ animated: false })}
          >
            <Pressable
              style={({ pressed }) => [styles.crumb, styles.crumbHome, pressed && styles.pressed]}
              onPress={() => goTo('')}
              accessibilityRole="button"
              accessibilityLabel="Project root"
            >
              <Ionicons name="home-outline" size={16} color={cwd ? color.muted : color.text} />
            </Pressable>
            {crumbs.map((seg, i) => {
              const last = i === crumbs.length - 1;
              return (
                <View key={`${seg}-${i}`} style={styles.crumbWrap}>
                  <Ionicons name="chevron-forward" size={12} color={color.iconFaint} />
                  <Pressable
                    style={({ pressed }) => [styles.crumb, pressed && !last && styles.pressed]}
                    disabled={last}
                    onPress={() => goTo(crumbs.slice(0, i + 1).join('/'))}
                    accessibilityRole="button"
                    accessibilityLabel={last ? `Current folder ${seg}` : `Go to ${seg}`}
                  >
                    <Text style={[styles.crumbText, last && styles.crumbCurrent]} numberOfLines={1}>{seg}</Text>
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
          <Pressable
            style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
            onPress={openCreateMenu}
            accessibilityRole="button"
            accessibilityLabel="New file or folder"
          >
            <Ionicons name="add" size={22} color={color.accent} />
          </Pressable>
        </View>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={15} color={color.muted} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search files and content…"
            placeholderTextColor={color.faint}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="search"
            accessibilityLabel="Search files and content"
          />
          {!!query && (
            <Pressable
              style={styles.clearBtn}
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Ionicons name="close-circle" size={16} color={color.muted} />
            </Pressable>
          )}
        </View>
      </ScreenHeader>

      {searching ? renderSearch() : renderListing()}

      {opening && <View style={styles.scrim}><ActivityIndicator color={color.accent} /></View>}

      <ActionSheet title={menu?.title} actions={menu?.actions ?? null} onClose={() => setMenu(null)} />
      <PromptDialog request={prompt} onClose={() => setPrompt(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  grow: { flexGrow: 1 },
  pressed: { backgroundColor: color.raised },

  crumbRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  crumbBar: {
    flex: 1,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
  },
  crumbs: { alignItems: 'center', paddingHorizontal: 2 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center' },
  // 44pt tall: every crumb is a navigation target, so each gets a full-size one.
  crumb: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 8,
    borderRadius: radius.sm, maxWidth: 180,
  },
  crumbHome: { minWidth: 44, alignItems: 'center' },
  crumbText: { color: color.muted, fontSize: 13 },
  crumbCurrent: { color: color.text, fontWeight: '600' },
  addBtn: {
    width: 46, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border,
  },

  listOuter: { paddingHorizontal: 16, paddingTop: 14 },
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.borderSoft,
    borderRadius: radius.card,
    overflow: 'hidden',
    // No gesture inset: this is a tab screen, and the tab bar below already reserves
    // whatever the device needs. This is just the card's own breathing room.
    marginBottom: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, paddingRight: 10, height: 50 },
  rowPressed: { backgroundColor: color.raised },
  rowIcon: { width: 18, marginRight: 12, alignItems: 'center' },
  rowName: { color: color.body, fontSize: font.size.md, flex: 1 },
  rowDir: { color: color.text, fontWeight: '500' },
  rowMore: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingLeft: 10,
    marginBottom: 12,
  },
  searchInput: { flex: 1, color: color.text, fontSize: 13, paddingVertical: 8, minHeight: 40 },
  clearBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  searchHead: {
    color: color.faint,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  searchRow: { height: undefined, minHeight: 44, paddingVertical: 6 },
  searchBody: { flex: 1, minWidth: 0 },
  snippet: { color: color.faint, fontSize: 11, fontFamily: font.mono },

  scrim: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: alpha(color.bg, 0.73),
  },
});
