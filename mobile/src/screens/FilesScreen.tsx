// File browser + viewer/editor. Mirrors the desktop explorer's list-dir /
// read-text / write-text channels (repo-relative paths, {ok,...} results), and
// reuses its file icons and its syntax highlighting — see FileIcon and CodeView.
//
// The browser is one card of rows under a breadcrumb; opening a file replaces the
// whole screen with the viewer, which keeps its own compact bar (a large title
// would cost the file half its height).
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, Alert, StyleSheet, ActivityIndicator,
  ScrollView, KeyboardAvoidingView, Platform, BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import { langFor } from '../generated/desktop-assets';
import FileIcon from '../components/FileIcon';
import CodeView from '../components/CodeView';
import ScreenHeader, { ChromeContext, NoProject } from '../components/ScreenHeader';
import { Divider } from '../components/ui';
import { showError, errorText } from '../components/ErrorDialog';
import { isApk, installApk } from '../api/installApk';
import { color, radius, font, inset } from '../theme';

type Entry = { name: string; dir: boolean };
type Ref = { file: string; line: number; text: string };
type Found = { files: string[]; refs: Ref[]; refsPending: boolean };

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parent = (rel: string) => rel.split('/').slice(0, -1).join('/');

export default function FilesScreen() {
  const { conn } = useConnection();
  const { project } = useContext(ChromeContext);
  const insets = useSafeAreaInsets();
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);

  // Search mirrors the desktop explorer/Ctrl+P: filenames first (search-names,
  // fast), then content hits (search-refs, git grep) streamed in below. A run
  // token drops a slow response once the query has moved on.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const searchRun = useRef(0);

  // The tree watcher fires in bursts; one listing in flight at a time is plenty.
  const busy = useRef(false);
  const cwdRef = useRef('');
  cwdRef.current = cwd;

  const list = useCallback(async (rel: string) => {
    if (!conn || busy.current) return;
    busy.current = true;
    try {
      const r: any = await conn.req('list-dir', rel);
      if (r?.ok) { setCwd(rel); setEntries(r.entries); }
      else showError('Files', r?.error ?? 'Could not read that folder.');
    } catch {
      // Socket dropped mid-request; the reconnect re-lists on focus.
    } finally {
      busy.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [conn]);

  // Re-list on focus, when the desktop's watcher reports the tree moved, and when
  // the project changes out from under us.
  useFocusEffect(useCallback(() => { list(cwdRef.current); }, [list]));

  useEffect(() => {
    const offTree = conn?.on('tree-changed', () => { if (!file) list(cwdRef.current); });
    const offFolder = conn?.on('folder-changed', () => { setFile(null); setLoading(true); list(''); });
    return () => { offTree?.(); offFolder?.(); };
  }, [conn, file, list]);

  const openPath = async (rel: string) => {
    const name = rel.split('/').pop()!;
    // An .apk isn't text — on Android, pull its bytes and hand it to the OS
    // package installer instead of trying to render it in the viewer.
    if (Platform.OS === 'android' && isApk(name)) {
      if (!conn) return;
      setOpening(true);
      try {
        await installApk({
          req: (ch, args, opts) => conn.req(ch, args, opts),
          forwardPort: (port, path) => conn.forwardPort(port, path),
          closeForward: (port) => conn.closeForward(port),
        }, rel, name);
      } catch (err) {
        showError('Install APK', `Could not open the installer for ${name}.\n\n${errorText(err)}`);
      } finally { setOpening(false); }
      return;
    }
    setOpening(true);
    try {
      const r: any = await conn?.req('read-text', rel);
      if (!r?.ok) return showError('Files', r?.error ?? 'That file cannot be opened as text.');
      setFile(rel);
      setText(r.text);
      setDirty(false);
      setEditing(false);
    } finally { setOpening(false); }
  };

  const openEntry = (e: Entry) => {
    const rel = join(cwd, e.name);
    if (e.dir) { setLoading(true); return list(rel); }
    return openPath(rel);
  };

  useEffect(() => {
    const q = query.trim();
    if (!q || !conn) { setFound(null); return; }
    const run = ++searchRun.current;
    const timer = setTimeout(async () => {
      try {
        const names: any = await conn.req('search-names', q);
        if (run !== searchRun.current) return;
        setFound({ files: names?.ok ? names.files : [], refs: [], refsPending: true });
        const refs: any = await conn.req('search-refs', q);
        if (run !== searchRun.current) return;
        setFound((prev) => prev && { ...prev, refs: refs?.ok ? refs.matches : [], refsPending: false });
      } catch {
        // Socket dropped mid-request; the next keystroke retries.
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, conn]);

  const save = async () => {
    setSaving(true);
    try {
      const r: any = await conn?.req('write-text', { file, text });
      if (!r?.ok) return showError('Files', r?.error ?? 'Save failed.');
      setDirty(false);
    } finally { setSaving(false); }
  };

  const closeFile = useCallback(() => {
    if (!dirty) { setFile(null); return; }
    Alert.alert('Discard changes?', `${file?.split('/').pop()} has unsaved edits.`, [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { setFile(null); setDirty(false); } },
    ]);
  }, [dirty, file]);

  // Android back: leave the file, else climb a folder, before backing out of the
  // tab. Returning true swallows the event.
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (file) { closeFile(); return true; }
      if (cwdRef.current) { setLoading(true); list(parent(cwdRef.current)); return true; }
      return false;
    });
    return () => sub.remove();
  }, [file, closeFile, list]));

  if (!project) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Files" />
        <NoProject />
      </View>
    );
  }

  if (file) {
    const name = file.split('/').pop()!;
    const dir = parent(file);
    return (
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
      >
        {/* Measured like every other frame — the design's 54 is an iPhone notch and
            would sit this bar too low on Android. */}
        <View style={[styles.bar, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
          <Pressable style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]} hitSlop={8} onPress={closeFile}>
            <Ionicons name="chevron-back" size={20} color={color.accent} />
          </Pressable>
          <FileIcon name={name} size={16} />
          <View style={styles.barTitle}>
            <Text style={styles.fileName} numberOfLines={1}>{name}{dirty ? ' •' : ''}</Text>
            {!!dir && <Text style={styles.filePath} numberOfLines={1}>{dir}</Text>}
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            hitSlop={8}
            onPress={() => setEditing((v) => !v)}
          >
            <Ionicons name={editing ? 'eye-outline' : 'create-outline'} size={19} color={color.accent} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, !dirty && styles.saveBtnOff, pressed && dirty && styles.savePressed]}
            disabled={!dirty || saving}
            onPress={save}
          >
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={[styles.saveLabel, !dirty && styles.saveLabelOff]}>{dirty ? 'Save' : 'Saved'}</Text>}
          </Pressable>
        </View>

        {editing ? (
          <TextInput
            style={styles.editor}
            value={text}
            onChangeText={(v) => { setText(v); setDirty(true); }}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
          />
        ) : (
          <CodeView code={text} lang={langFor(name)} />
        )}
      </KeyboardAvoidingView>
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
      head: found.refsPending ? 'References…' : `References (${found.refs.length})`,
    });
    found.refs.forEach((m, i) => searchRows.push({ key: `r-${i}`, file: m.file, line: m.line, snippet: m.text }));
  }

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Files">
        {/* The breadcrumb doubles as the up control — every segment is a target, so
            a dedicated back button would only repeat the second-to-last crumb. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.crumbBar}
          contentContainerStyle={styles.crumbs}
          ref={(r) => r?.scrollToEnd({ animated: false })}
        >
          <Pressable style={({ pressed }) => [styles.crumb, pressed && styles.pressed]} onPress={() => list('')}>
            <Ionicons name="home-outline" size={14} color={cwd ? color.muted : color.text} />
          </Pressable>
          {crumbs.map((seg, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={`${seg}-${i}`} style={styles.crumbWrap}>
                <Ionicons name="chevron-forward" size={12} color={color.iconFaint} />
                <Pressable
                  style={({ pressed }) => [styles.crumb, pressed && !last && styles.pressed]}
                  disabled={last}
                  onPress={() => { setLoading(true); list(crumbs.slice(0, i + 1).join('/')); }}
                >
                  <Text style={[styles.crumbText, last && styles.crumbCurrent]} numberOfLines={1}>{seg}</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
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
          />
          {!!query && (
            <Pressable hitSlop={8} onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={16} color={color.muted} />
            </Pressable>
          )}
        </View>
      </ScreenHeader>

      {searching ? (
        !found ? (
          <View style={styles.center}><ActivityIndicator color={color.accent} /></View>
        ) : (
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
                  onPress={() => openPath(item.file!)}
                >
                  <View style={styles.rowIcon}>
                    <FileIcon name={item.file!.split('/').pop()!} size={18} />
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
        )
      ) : loading ? (
        <View style={styles.center}><ActivityIndicator color={color.accent} /></View>
      ) : (
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
            <View style={styles.center}>
              <Ionicons name="folder-open-outline" size={34} color={color.border} />
              <Text style={styles.empty}>This folder is empty.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => openEntry(item)}
            >
              <View style={styles.rowIcon}>
                <FileIcon name={item.name} dir={item.dir} size={18} />
              </View>
              <Text style={[styles.rowName, item.dir && styles.rowDir]} numberOfLines={1}>{item.name}</Text>
              {item.dir && <Ionicons name="chevron-forward" size={16} color={color.iconFaint} />}
            </Pressable>
          )}
        />
      )}

      {opening && <View style={styles.scrim}><ActivityIndicator color={color.accent} /></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  grow: { flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  empty: { color: color.faint, fontSize: 13 },

  // The viewer's bar: compact on purpose — it sits above the file, not above a
  // screen, so it keeps the old chrome rather than a ScreenHeader.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 6,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: color.raised },

  crumbBar: {
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    marginBottom: 12,
    flexGrow: 0,
  },
  crumbs: { alignItems: 'center', paddingHorizontal: 6, paddingVertical: 3 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center' },
  crumb: { paddingHorizontal: 4, paddingVertical: 4, borderRadius: radius.sm, maxWidth: 160 },
  crumbText: { color: color.muted, fontSize: 13 },
  crumbCurrent: { color: color.text, fontWeight: '600' },

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
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 50 },
  rowPressed: { backgroundColor: color.raised },
  rowIcon: { width: 18, marginRight: 12, alignItems: 'center' },
  rowName: { color: color.body, fontSize: font.size.md, flex: 1 },
  rowDir: { color: color.text, fontWeight: '500' },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.bg,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    marginBottom: 12,
  },
  searchInput: { flex: 1, color: color.text, fontSize: 13, paddingVertical: 8 },
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

  barTitle: { flex: 1, minWidth: 0 },
  fileName: { color: color.text, fontSize: 14, fontWeight: '600' },
  filePath: { color: color.faint, fontSize: 11 },
  saveBtn: {
    minWidth: 62,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: color.greenDeep,
  },
  saveBtnOff: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  savePressed: { backgroundColor: '#2ea043' },
  saveLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  saveLabelOff: { color: color.faint },

  // The editor keeps CodeView's own surface: the two swap in place, and a GitHub-dark
  // TextInput behind VS-Code-themed syntax would make editing look like a different file.
  editor: {
    flex: 1,
    color: '#d4d4d4',
    backgroundColor: '#1e1e1e',
    fontFamily: font.mono,
    fontSize: 13,
    lineHeight: 19,
    padding: 12,
  },
  scrim: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0d1117bb' },
});
