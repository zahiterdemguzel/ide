// Claude sessions of the open project: list, create, resume, open terminal.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, Button, StyleSheet } from 'react-native';
import { useConnection } from '../api/context';

type Session = {
  id: string; repo: string; firstPrompt: string; name: string;
  archived: boolean; state: string; files: number; model: string;
};

const STATE_COLORS: Record<string, string> = {
  working: '#e5c07b', waiting: '#61afef', completed: '#98c379',
  pushed: '#98c379', interrupted: '#e06c75', idle: '#888',
};

export default function SessionsScreen({ navigation }: any) {
  const { conn } = useConnection();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repo, setRepo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!conn) return;
    const [list, repoPath] = await Promise.all([
      conn.req<Session[]>('get-sessions'),
      conn.req<string | null>('get-repo-path'),
    ]);
    setRepo(repoPath);
    setSessions(list.filter((s) => !repoPath || s.repo === repoPath));
  }, [conn]);

  useEffect(() => {
    refresh();
    const offs = [
      conn?.on('status', ({ id, state }: any) =>
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state } : s)))),
      conn?.on('session-name', ({ id, name }: any) =>
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))),
      conn?.on('session-meta', () => refresh()),
    ];
    return () => offs.forEach((off) => off?.());
  }, [conn, refresh]);

  const newSession = async () => {
    const r: any = await conn?.req('new-session', { cols: 80, rows: 30 });
    if (r?.id) navigation.navigate('Terminal', { id: r.id, resume: false });
    refresh();
  };

  const open = async (s: Session) => {
    if (s.archived) await conn?.req('resume-session', { id: s.id, cols: 80, rows: 30 });
    navigation.navigate('Terminal', { id: s.id, resume: false });
  };

  useEffect(() => {
    navigation.setOptions({ headerRight: () => <Button title="New" onPress={newSession} /> });
  });

  return (
    <View style={styles.fill}>
      {!repo && <Text style={styles.empty}>Open a project first.</Text>}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        refreshing={false}
        onRefresh={refresh}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => open(item)}>
            <View style={[styles.dot, { backgroundColor: STATE_COLORS[item.state] ?? '#888' }]} />
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name || item.firstPrompt || 'Unnamed session'}
              </Text>
              <Text style={styles.meta}>
                {item.state}{item.archived ? ' · archived' : ''}{item.files ? ` · ${item.files} files` : ''}
              </Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={repo ? <Text style={styles.empty}>No sessions yet — tap New.</Text> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  info: { flex: 1 },
  name: { color: '#fff', fontSize: 15 },
  meta: { color: '#888', fontSize: 12 },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
});
