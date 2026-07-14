// Recent projects — the mobile "home". Picking one switches the project on the
// desktop too (the repo path is shared; that's the intended remote-switch
// semantic). Also the hub for Sessions / Git / Files / Ports.
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, Button, StyleSheet } from 'react-native';
import { useConnection } from '../api/context';

export default function ProjectsScreen({ navigation }: any) {
  const { conn, state, unpair } = useConnection();
  const [folders, setFolders] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!conn || state !== 'ready') return;
    setFolders(await conn.req('get-recent-folders'));
    setCurrent(await conn.req('get-repo-path'));
  }, [conn, state]);

  useEffect(() => {
    refresh();
    const off = conn?.on('folder-changed', ({ repo }: any) => setCurrent(repo));
    return off;
  }, [conn, refresh]);

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => <Button title="Unpair" onPress={unpair} />,
    });
  }, [navigation, unpair]);

  const open = async (dir: string) => {
    const r: any = await conn?.req('open-folder-path', dir);
    if (!r?.canceled) setCurrent(r.repo);
  };

  const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  return (
    <View style={styles.fill}>
      {state !== 'ready' && <Text style={styles.badge}>{state}…</Text>}
      {current && (
        <View style={styles.nav}>
          <Text style={styles.current}>{basename(current)}</Text>
          <View style={styles.navRow}>
            <Button title="Sessions" onPress={() => navigation.navigate('Sessions')} />
            <Button title="Git" onPress={() => navigation.navigate('Git')} />
            <Button title="Files" onPress={() => navigation.navigate('Files')} />
            <Button title="Ports" onPress={() => navigation.navigate('Ports')} />
          </View>
        </View>
      )}
      <FlatList
        data={folders}
        keyExtractor={(p) => p}
        refreshing={false}
        onRefresh={refresh}
        renderItem={({ item }) => (
          <Pressable style={[styles.row, item === current && styles.rowActive]} onPress={() => open(item)}>
            <Text style={styles.name}>{basename(item)}</Text>
            <Text style={styles.path} numberOfLines={1}>{item}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No recent projects on the desktop yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  badge: { color: '#fb0', textAlign: 'center', padding: 4 },
  nav: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#444' },
  navRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 8 },
  current: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  row: { padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  rowActive: { backgroundColor: '#264f78' },
  name: { color: '#fff', fontSize: 16 },
  path: { color: '#888', fontSize: 12 },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
});
