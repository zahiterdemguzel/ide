// Run panel: the desktop's run toolbar (.vscode/launch.json + tasks.json), plus
// the terminals it opened. Slides in from the right — the mirror of ProjectDrawer,
// so the two side actions bracket the header.
//
// Nothing runs on the phone: starting a config asks the desktop to open it in a
// terminal tab exactly as clicking its toolbar button would (`run-config-start`),
// so the two ends can't drift. A launch config counts as "running" for as long as
// its terminal is open — the same definition the desktop toolbar uses — which is
// why the state here is derived from the live terminal list.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import { showError } from './ErrorDialog';

type LaunchConfig = { name: string; compound?: boolean; members?: string[] };
type RunConfigs = { launch: LaunchConfig[]; tasks: { name: string }[] };
type TerminalInfo = { id: string; name: string; kind: string };

type Props = { visible: boolean; onClose: () => void };

export default function RunDrawer({ visible, onClose }: Props) {
  const { conn, state } = useConnection();
  const navigation = useNavigation<any>();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, width * 0.86);
  const slide = useRef(new Animated.Value(panelWidth)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [configs, setConfigs] = useState<RunConfigs>({ launch: [], tasks: [] });
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The two halves of this panel are fetched *independently*. They used to be one
  // `Promise.all` inside one silent `catch {}`, which failed in the worst possible way:
  // `Promise.all` rejects as a unit, so whichever channel broke took the other's result
  // down with it, and the panel rendered empty — no configs, no tasks, no terminals, and
  // nothing on screen saying anything had gone wrong. An empty panel is also what a
  // project with no .vscode files legitimately looks like, so the failure was
  // indistinguishable from the normal case. Settle them separately and say so.
  const refresh = useCallback(async () => {
    if (!conn || state !== 'ready') return;
    const [cfg, terms] = await Promise.allSettled([
      conn.req<RunConfigs>('get-run-configs'),
      conn.req<TerminalInfo[]>('term-list'),
    ]);
    if (cfg.status === 'fulfilled') {
      setConfigs({ launch: cfg.value?.launch ?? [], tasks: cfg.value?.tasks ?? [] });
    }
    if (terms.status === 'fulfilled') setTerminals(terms.value ?? []);
    const failed = [cfg, terms].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    setError(failed ? (failed.reason?.message ?? String(failed.reason)) : null);
  }, [conn, state]);

  // Live: main pushes the terminal list on every open/close, and re-reads the
  // .vscode files when they're edited. Registered once, not gated on `visible`, so
  // the panel is already current the moment it opens.
  useEffect(() => {
    const offs = [
      conn?.on('terminals-changed', (list: any) => setTerminals(list ?? [])),
      conn?.on('run-configs-changed', () => refresh()),
      conn?.on('folder-changed', () => refresh()), // a different project has different configs
    ];
    return () => offs.forEach((off) => off?.());
  }, [conn, refresh]);

  useEffect(() => {
    if (visible) refresh();
    Animated.parallel([
      Animated.timing(slide, {
        toValue: visible ? 0 : panelWidth,
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

  const running = new Set(terminals.filter((t) => t.kind === 'config').map((t) => t.name));
  const isRunning = (c: LaunchConfig) =>
    c.compound ? (c.members ?? []).some((m) => running.has(m)) : running.has(c.name);

  const start = async (kind: 'launch' | 'task', name: string) => {
    if (!conn || busy) return;
    setBusy(name);
    try {
      const r = await conn.req<{ ok: boolean; error?: string }>('run-config-start', { kind, name });
      if (!r?.ok) showError(name, r?.error || 'Could not start this config.');
    } catch (e: any) {
      showError(name, e);
    } finally {
      setBusy(null);
    }
  };

  const stop = async (name: string) => {
    if (!conn) return;
    try { await conn.req('run-config-stop', { name }); } catch { /* it's already gone */ }
  };

  // Deliberately no onClose() here: the panel stays logically open so it's still
  // there when the user backs out of the terminal. While Console has focus the
  // hub hides the modal (App.tsx gates `visible` on the Main screen's focus).
  const openTerminal = (t: TerminalInfo) => {
    navigation.navigate('Console', { id: t.id, name: t.name });
  };

  const empty = !configs.launch.length && !configs.tasks.length;

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.scrim, { opacity: fade }]}>
        <Pressable style={styles.fill} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.panel, { width: panelWidth, transform: [{ translateX: slide }] }]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'right']}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Run</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Ionicons name="close" size={22} color="#7d8590" />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {/* A panel that is empty because the desktop refused the request must not
                look like a project that simply has no configs. */}
            {!!error && <Text style={styles.error}>Couldn’t load from the desktop: {error}</Text>}

            {empty && !error && (
              <Text style={styles.empty}>
                No .vscode/launch.json or tasks.json in this project.
              </Text>
            )}

            {!!configs.launch.length && <Text style={styles.section}>LAUNCH</Text>}
            {configs.launch.map((c) => {
              const live = isRunning(c);
              const pending = busy === c.name;
              return (
                <View key={c.name} style={styles.row}>
                  <Ionicons
                    name={c.compound ? 'layers-outline' : 'rocket-outline'}
                    size={16}
                    color={live ? '#3fb950' : '#7d8590'}
                  />
                  <Text style={[styles.rowName, live && styles.rowNameLive]} numberOfLines={1}>
                    {c.name}
                  </Text>

                  {live && (
                    <Pressable
                      onPress={() => stop(c.name)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.action, styles.stop, pressed && styles.actionPressed]}
                    >
                      <Ionicons name="stop" size={13} color="#ffa198" />
                    </Pressable>
                  )}

                  {/* Same button start and restart: the desktop reuses the config's
                      existing tab, so a second tap is a rerun. */}
                  <Pressable
                    onPress={() => start('launch', c.name)}
                    disabled={pending}
                    hitSlop={8}
                    style={({ pressed }) => [styles.action, styles.play, pressed && styles.actionPressed]}
                  >
                    {pending
                      ? <ActivityIndicator size="small" color="#3fb950" />
                      : <Ionicons name={live ? 'refresh' : 'play'} size={14} color="#3fb950" />}
                  </Pressable>
                </View>
              );
            })}

            {!!configs.tasks.length && <Text style={styles.section}>TASKS</Text>}
            {configs.tasks.map((t) => {
              const pending = busy === t.name;
              return (
                <View key={t.name} style={styles.row}>
                  <Ionicons name="construct-outline" size={16} color="#7d8590" />
                  <Text style={styles.rowName} numberOfLines={1}>{t.name}</Text>
                  <Pressable
                    onPress={() => start('task', t.name)}
                    disabled={pending}
                    hitSlop={8}
                    style={({ pressed }) => [styles.action, styles.play, pressed && styles.actionPressed]}
                  >
                    {pending
                      ? <ActivityIndicator size="small" color="#3fb950" />
                      : <Ionicons name="play" size={14} color="#3fb950" />}
                  </Pressable>
                </View>
              );
            })}

            <Text style={styles.section}>TERMINALS</Text>
            {terminals.length === 0 && <Text style={styles.empty}>No terminals open.</Text>}
            {terminals.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => openTerminal(t)}
                style={({ pressed }) => [styles.row, styles.termRow, pressed && styles.rowPressed]}
              >
                <Ionicons
                  name={t.kind === 'config' ? 'terminal' : 'terminal-outline'}
                  size={16}
                  color={t.kind === 'config' ? '#3fb950' : '#7d8590'}
                />
                <Text style={styles.rowName} numberOfLines={1}>{t.name}</Text>
                <Ionicons name="chevron-forward" size={16} color="#7d8590" />
              </Pressable>
            ))}
          </ScrollView>
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
    right: 0,
    backgroundColor: '#161b22',
    borderLeftColor: '#30363d',
    borderLeftWidth: StyleSheet.hairlineWidth,
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
  headerTitle: { color: '#e6edf3', fontSize: 16, fontWeight: '700' },
  body: { paddingBottom: 24 },
  section: {
    color: '#7d8590', fontSize: 10, fontWeight: '700', letterSpacing: 0.8,
    paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  termRow: { borderTopColor: '#21262d', borderTopWidth: StyleSheet.hairlineWidth },
  rowPressed: { backgroundColor: '#21262d' },
  rowName: { flex: 1, color: '#e6edf3', fontSize: 14, fontWeight: '600' },
  rowNameLive: { color: '#3fb950' },
  action: {
    width: 30, height: 30, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  actionPressed: { backgroundColor: '#30363d' },
  play: { backgroundColor: '#21262d', borderColor: '#3fb95033' },
  stop: { backgroundColor: '#21262d', borderColor: '#f8514933' },
  empty: { color: '#7d8590', fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  error: {
    color: '#ffa198', fontSize: 12, lineHeight: 17,
    marginHorizontal: 16, marginTop: 12, padding: 10,
    backgroundColor: '#f8514915', borderRadius: 6,
    borderWidth: 1, borderColor: '#f8514933',
  },
});
