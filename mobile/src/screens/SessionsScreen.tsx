// Claude sessions of the open project: list, create, resume, archive, delete.
// Mirrors the desktop sessions panel: Active/Archived/All tabs, newest-first.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';

type Session = {
  id: string; repo: string; firstPrompt: string; name: string;
  archived: boolean; state: string; files: string[]; model: string;
};

type Tab = 'active' | 'archived' | 'all';
const TABS: { key: Tab; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

const STATE_COLORS: Record<string, string> = {
  working: '#e5c07b', waiting: '#61afef', completed: '#98c379',
  pushed: '#98c379', interrupted: '#e06c75', idle: '#7d8590',
};

export default function SessionsScreen({ navigation }: any) {
  const { conn } = useConnection();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');

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

  // get-sessions returns creation order; the newest session belongs on top.
  const shown = useMemo(() => {
    const match = (s: Session) =>
      tab === 'all' ? true : tab === 'archived' ? s.archived : !s.archived;
    return sessions.filter(match).slice().reverse();
  }, [sessions, tab]);

  const counts = useMemo(() => ({
    active: sessions.filter((s) => !s.archived).length,
    archived: sessions.filter((s) => s.archived).length,
    all: sessions.length,
  }), [sessions]);

  const newSession = async () => {
    try {
      const r: any = await conn?.req('new-session', { cols: 80, rows: 30 });
      // The desktop wraps handler failures in { error } instead of rejecting.
      if (r?.error || !r?.id) {
        Alert.alert('Could not create session', r?.error ?? 'Unknown error');
        return;
      }
      navigation.navigate('Terminal', { id: r.id, resume: false });
    } catch (e: any) {
      Alert.alert('Could not create session', e?.message ?? String(e));
    } finally {
      refresh();
    }
  };

  const open = async (s: Session) => {
    if (s.archived) await conn?.req('resume-session', { id: s.id, cols: 80, rows: 30 });
    navigation.navigate('Terminal', { id: s.id, resume: false });
  };

  const archive = (s: Session) => {
    conn?.send('suspend-session', { id: s.id });
    setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, archived: true } : x)));
  };

  const unarchive = async (s: Session) => {
    await conn?.req('resume-session', { id: s.id, cols: 80, rows: 30 });
    refresh();
  };

  const remove = (s: Session) => {
    Alert.alert(
      'Delete session?',
      `“${title(s)}” will be permanently deleted. Its conversation cannot be restored.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            conn?.send('kill-session', { id: s.id });
            setSessions((prev) => prev.filter((x) => x.id !== s.id));
          },
        },
      ],
    );
  };

  const emptyText = !repo
    ? 'Open a project first.'
    : tab === 'archived'
      ? 'No archived sessions.'
      : 'No sessions yet — tap New session.';

  return (
    <View style={styles.fill}>
      <View style={styles.tabs}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable
              key={t.key}
              style={[styles.tab, on && styles.tabOn]}
              onPress={() => setTab(t.key)}
            >
              <Text style={[styles.tabLabel, on && styles.tabLabelOn]}>{t.label}</Text>
              <Text style={[styles.tabCount, on && styles.tabCountOn]}>{counts[t.key]}</Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        data={shown}
        keyExtractor={(s) => s.id}
        refreshing={false}
        onRefresh={refresh}
        contentContainerStyle={shown.length ? undefined : styles.fill}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => open(item)}
          >
            <View style={[styles.dot, { backgroundColor: STATE_COLORS[item.state] ?? '#7d8590' }]} />
            <Text
              style={[styles.name, item.archived && styles.nameArchived]}
              numberOfLines={1}
            >
              {title(item)}
            </Text>
            {item.archived ? (
              <>
                <IconBtn name="arrow-up-circle-outline" label="Restore" onPress={() => unarchive(item)} />
                <IconBtn name="trash-outline" label="Delete" danger onPress={() => remove(item)} />
              </>
            ) : (
              <IconBtn name="archive-outline" label="Archive" onPress={() => archive(item)} />
            )}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
      />

      <Pressable
        style={({ pressed }) => [styles.new, !repo && styles.newOff, pressed && repo && styles.newPressed]}
        onPress={newSession}
        disabled={!repo}
      >
        <Ionicons name="add" size={20} color={repo ? '#fff' : '#7d8590'} />
        <Text style={[styles.newLabel, !repo && styles.newLabelOff]}>New session</Text>
      </Pressable>
    </View>
  );
}

function title(s: Session) {
  return s.name || s.firstPrompt || 'Unnamed session';
}

function IconBtn(
  { name, label, onPress, danger }:
  { name: any; label: string; onPress: () => void; danger?: boolean },
) {
  return (
    <Pressable
      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={label}
    >
      <Ionicons name={name} size={19} color={danger ? '#e06c75' : '#7d8590'} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },

  tabs: {
    flexDirection: 'row', gap: 6, padding: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
    backgroundColor: '#161b22', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  tabOn: { backgroundColor: '#1f6feb22', borderColor: '#4da3ff' },
  tabLabel: { color: '#7d8590', fontSize: 13, fontWeight: '600' },
  tabLabelOn: { color: '#4da3ff' },
  tabCount: { color: '#57606a', fontSize: 12, fontVariant: ['tabular-nums'] },
  tabCountOn: { color: '#4da3ff' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#21262d',
  },
  rowPressed: { backgroundColor: '#161b22' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { flex: 1, color: '#e6edf3', fontSize: 15 },
  nameArchived: { color: '#7d8590' },

  iconBtn: { padding: 6, borderRadius: 6 },
  iconBtnPressed: { backgroundColor: '#21262d' },

  empty: { color: '#7d8590', textAlign: 'center', marginTop: 48 },

  new: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    margin: 12, paddingVertical: 12, borderRadius: 8, backgroundColor: '#238636',
  },
  newPressed: { backgroundColor: '#2ea043' },
  newOff: { backgroundColor: '#161b22', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d' },
  newLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  newLabelOff: { color: '#7d8590' },
});
