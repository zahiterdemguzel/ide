// Project switcher. Not a screen: a panel that slides in from the left over the
// current tab, so project selection stays a side action instead of the app's
// home. Picking one switches the project on the desktop too (shared repo path).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

type Props = { visible: boolean; onClose: () => void };

export default function ProjectDrawer({ visible, onClose }: Props) {
  const { conn, state, unpair, switchInstance } = useConnection();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, width * 0.82);
  const slide = useRef(new Animated.Value(-panelWidth)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [folders, setFolders] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // How many desktop windows are open right now. Only worth offering the switch when
  // there is somewhere to switch *to*, and that changes while the phone is connected.
  const [windows, setWindows] = useState(1);

  const refresh = useCallback(async () => {
    if (!conn || state !== 'ready') return;
    setFolders(await conn.req('get-recent-folders'));
    setCurrent(await conn.req('get-repo-path'));
    setWindows(((await conn.req<unknown[]>('list-instances').catch(() => [])) || []).length);
  }, [conn, state]);

  useEffect(() => {
    const off = conn?.on('folder-changed', ({ repo }: any) => setCurrent(repo));
    return off;
  }, [conn]);

  useEffect(() => {
    if (visible) refresh();
    Animated.parallel([
      Animated.timing(slide, {
        toValue: visible ? 0 : -panelWidth,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: visible ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, panelWidth, refresh, slide, fade]);

  const open = async (dir: string) => {
    const r: any = await conn?.req('open-folder-path', dir);
    if (!r?.canceled) setCurrent(r.repo);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.scrim, { opacity: fade }]}>
        <Pressable style={styles.fill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[styles.panel, { width: panelWidth, transform: [{ translateX: slide }] }]}
      >
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Text style={styles.title}>Switch project</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Ionicons name="close" size={22} color="#7d8590" />
            </Pressable>
          </View>

          <FlatList
            data={folders}
            keyExtractor={(p) => p}
            refreshing={false}
            onRefresh={refresh}
            renderItem={({ item }) => {
              const active = item === current;
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    active && styles.rowActive,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => open(item)}
                >
                  <Ionicons
                    name={active ? 'folder-open' : 'folder-outline'}
                    size={18}
                    color={active ? '#4da3ff' : '#7d8590'}
                  />
                  <View style={styles.rowText}>
                    <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                      {basename(item)}
                    </Text>
                    <Text style={styles.path} numberOfLines={1}>
                      {item}
                    </Text>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>No recent projects on the desktop yet.</Text>
            }
          />

          {windows > 1 && (
            <Pressable
              style={({ pressed }) => [styles.footerRow, pressed && styles.rowPressed]}
              onPress={() => { onClose(); switchInstance(); }}
            >
              <Ionicons name="desktop-outline" size={18} color="#4da3ff" />
              <Text style={styles.switchText}>Switch window ({windows} open)</Text>
            </Pressable>
          )}

          <Pressable style={styles.footerRow} onPress={unpair}>
            <Ionicons name="log-out-outline" size={18} color="#f85149" />
            <Text style={styles.unpairText}>Unpair</Text>
          </Pressable>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1,4,9,0.6)' },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#161b22',
    borderRightColor: '#30363d',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: '#30363d',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { color: '#e6edf3', fontSize: 16, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  rowActive: { backgroundColor: '#1f6feb22' },
  rowPressed: { backgroundColor: '#21262d' },
  rowText: { flex: 1 },
  name: { color: '#e6edf3', fontSize: 15, fontWeight: '600' },
  nameActive: { color: '#4da3ff' },
  path: { color: '#7d8590', fontSize: 11 },
  empty: { color: '#7d8590', textAlign: 'center', marginTop: 32, paddingHorizontal: 16 },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopColor: '#30363d',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  switchText: { color: '#4da3ff', fontSize: 14, fontWeight: '600' },
  unpairText: { color: '#f85149', fontSize: 14, fontWeight: '600' },
});
