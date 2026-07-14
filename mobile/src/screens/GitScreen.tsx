// Git pane: status, stage/unstage, commit, push/pull. Mirrors the desktop's
// git-* IPC channels (same payload shapes as src/main/git.js).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, SectionList, Pressable, TextInput, Button, Alert, StyleSheet } from 'react-native';
import { useConnection } from '../api/context';

type Entry = { status: string; file: string };
type Status = {
  ok: boolean; error?: string; staged: Entry[]; unstaged: Entry[]; conflicts: Entry[];
  branch?: string; ahead?: number; behind?: number;
};

export default function GitScreen() {
  const { conn } = useConnection();
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn) return;
    setStatus(await conn.req<Status>('git-status'));
  }, [conn]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { Alert.alert('Git', String(e?.message ?? e)); }
    setBusy(false);
    refresh();
  };

  const commit = () => run(async () => {
    const r: any = await conn?.req('git-commit', msg.trim());
    if (r && r.ok === false) throw new Error(r.stderr || 'commit failed');
    setMsg('');
  });

  const sections = status ? [
    { title: `Staged (${status.staged.length})`, data: status.staged, staged: true },
    { title: `Changes (${status.unstaged.length})`, data: status.unstaged, staged: false },
    ...(status.conflicts.length ? [{ title: `Conflicts (${status.conflicts.length})`, data: status.conflicts, staged: false }] : []),
  ] : [];

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <Text style={styles.branch}>
          {status?.branch || '—'}
          {status?.ahead ? ` ↑${status.ahead}` : ''}{status?.behind ? ` ↓${status.behind}` : ''}
        </Text>
        <Button title="Pull" disabled={busy} onPress={() => run(() => conn!.req('git-pull'))} />
        <Button title="Push" disabled={busy} onPress={() => run(() => conn!.req('git-push'))} />
      </View>
      {status && !status.ok && <Text style={styles.error}>{status.error}</Text>}
      <SectionList
        sections={sections}
        keyExtractor={(e, i) => e.file + i}
        refreshing={false}
        onRefresh={refresh}
        renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
        renderItem={({ item, section }: any) => (
          <Pressable
            style={styles.row}
            onPress={() => run(() => conn!.req(section.staged ? 'git-unstage' : 'git-stage', item.file))}
          >
            <Text style={styles.stat}>{item.status}</Text>
            <Text style={styles.file} numberOfLines={1}>{item.file}</Text>
            <Text style={styles.hintTxt}>{section.staged ? 'unstage' : 'stage'}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>Working tree clean.</Text>}
      />
      <View style={styles.commitBar}>
        <TextInput
          style={styles.input}
          placeholder="Commit message"
          placeholderTextColor="#777"
          value={msg}
          onChangeText={setMsg}
        />
        <Button title="Commit" disabled={busy || !msg.trim() || !status?.staged.length} onPress={commit} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 },
  branch: { color: '#fff', flex: 1, fontSize: 16, fontWeight: '600' },
  error: { color: '#e06c75', padding: 10 },
  section: { color: '#aaa', backgroundColor: '#252525', paddingHorizontal: 12, paddingVertical: 4, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  stat: { color: '#e5c07b', width: 24, fontFamily: 'monospace' },
  file: { color: '#ddd', flex: 1 },
  hintTxt: { color: '#61afef', fontSize: 12, marginLeft: 8 },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
  commitBar: { flexDirection: 'row', padding: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#444' },
  input: { flex: 1, color: '#fff', backgroundColor: '#2a2a2a', borderRadius: 6, paddingHorizontal: 10 },
});
