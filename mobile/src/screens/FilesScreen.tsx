// File browser + viewer/editor. Mirrors the desktop explorer's list-dir /
// read-text / write-text channels (repo-relative paths, {ok,...} results), and
// reuses its file icons and its syntax highlighting — see FileIcon and CodeView.
//
// Deliberately does NOT call navigation.setOptions({title}): in a bottom-tab
// navigator `title` feeds the tab bar label as well as the header, so setting it
// to the current folder renamed the "Files" tab button as you browsed.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, Alert, StyleSheet, ActivityIndicator,
  ScrollView, KeyboardAvoidingView, Platform, BackHandler,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import { langFor } from '../generated/desktop-assets';
import FileIcon from '../components/FileIcon';
import CodeView from '../components/CodeView';
import { showError } from '../components/ErrorDialog';

type Entry = { name: string; dir: boolean };

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parent = (rel: string) => rel.split('/').slice(0, -1).join('/');

export default function FilesScreen() {
  const { conn } = useConnection();
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

  const openEntry = async (e: Entry) => {
    const rel = join(cwd, e.name);
    if (e.dir) { setLoading(true); return list(rel); }
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

  if (file) {
    const name = file.split('/').pop()!;
    const dir = parent(file);
    return (
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
      >
        <View style={styles.bar}>
          <Pressable style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]} hitSlop={8} onPress={closeFile}>
            <Ionicons name="chevron-back" size={20} color="#4da3ff" />
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
            <Ionicons name={editing ? 'eye-outline' : 'create-outline'} size={19} color="#4da3ff" />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, !dirty && styles.saveBtnOff, pressed && dirty && styles.savePressed]}
            disabled={!dirty || saving}
            onPress={save}
          >
            {saving
              ? <ActivityIndicator size="small" color="#ffffff" />
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

  return (
    <View style={styles.fill}>
      <View style={styles.bar}>
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed, !cwd && styles.iconBtnOff]}
          hitSlop={8}
          disabled={!cwd}
          onPress={() => { setLoading(true); list(parent(cwd)); }}
        >
          <Ionicons name="chevron-back" size={20} color={cwd ? '#4da3ff' : '#484f58'} />
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.crumbs}
          ref={(r) => r?.scrollToEnd({ animated: false })}
        >
          <Pressable style={({ pressed }) => [styles.crumb, pressed && styles.pressed]} onPress={() => list('')}>
            <Ionicons name="home-outline" size={14} color={cwd ? '#7d8590' : '#e6edf3'} />
          </Pressable>
          {crumbs.map((seg, i) => {
            const last = i === crumbs.length - 1;
            return (
              <View key={`${seg}-${i}`} style={styles.crumbWrap}>
                <Ionicons name="chevron-forward" size={12} color="#484f58" />
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
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color="#4da3ff" /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.name}
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); list(cwd); }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={entries.length ? undefined : styles.grow}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="folder-open-outline" size={34} color="#30363d" />
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
              {item.dir && <Ionicons name="chevron-forward" size={16} color="#484f58" />}
            </Pressable>
          )}
        />
      )}

      {opening && <View style={styles.scrim}><ActivityIndicator color="#4da3ff" /></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0d1117' },
  grow: { flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  empty: { color: '#6e7681', fontSize: 13 },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#161b22',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#30363d',
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  iconBtnOff: { opacity: 0.5 },
  pressed: { backgroundColor: '#21262d' },

  crumbs: { alignItems: 'center', paddingRight: 8 },
  crumbWrap: { flexDirection: 'row', alignItems: 'center' },
  crumb: { paddingHorizontal: 6, paddingVertical: 5, borderRadius: 6, maxWidth: 160 },
  crumbText: { color: '#7d8590', fontSize: 13 },
  crumbCurrent: { color: '#e6edf3', fontWeight: '600' },

  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#21262d', marginLeft: 46 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 48 },
  rowPressed: { backgroundColor: '#161b22' },
  rowIcon: { width: 18, marginRight: 14, alignItems: 'center' },
  rowName: { color: '#c9d1d9', fontSize: 15, flex: 1 },
  rowDir: { color: '#e6edf3', fontWeight: '500' },

  barTitle: { flex: 1, minWidth: 0 },
  fileName: { color: '#e6edf3', fontSize: 14, fontWeight: '600' },
  filePath: { color: '#6e7681', fontSize: 11 },
  saveBtn: {
    minWidth: 62,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#238636',
  },
  saveBtnOff: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d' },
  savePressed: { backgroundColor: '#2ea043' },
  saveLabel: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
  saveLabelOff: { color: '#6e7681' },

  editor: {
    flex: 1,
    color: '#d4d4d4',
    backgroundColor: '#1e1e1e',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    lineHeight: 19,
    padding: 12,
  },
  scrim: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0d1117bb' },
});
