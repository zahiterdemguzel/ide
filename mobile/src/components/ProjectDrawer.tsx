// Project switcher. Not a screen: a panel that slides in from the left over the
// current tab, so project selection stays a side action instead of the app's
// home. Picking one switches the project on the desktop too (shared repo path).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import { color, font, radius, space, tint } from '../theme';
import { confirmAction, haptic, showToast } from './feedback';
import { showError } from './ErrorDialog';
import { ErrorState, EmptyState, LoadingState } from './ui';

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
  // `loaded` gates the empty text: before the first answer, "No recent projects" would
  // be a claim about a list we haven't seen.
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The folder being switched to, so its row can show a spinner while the desktop
  // opens it (a big repo takes a moment) and a second tap can't fire another switch.
  const [opening, setOpening] = useState<string | null>(null);

  // Guard on the connection's own live state (like SessionsScreen), not the context
  // snapshot: the snapshot can lag right after a window switch re-dials.
  // Resolves whether the list came back, so a pull can say when it didn't.
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!conn || conn.state !== 'ready') return false;
    try {
      const [recent, repo] = await Promise.all([
        conn.req<string[]>('get-recent-folders'),
        conn.req<string | null>('get-repo-path'),
      ]);
      setFolders(recent || []);
      setCurrent(repo);
      setLoadError(null);
      setLoaded(true);
    } catch (e: any) {
      setLoadError(errorMessage(e));
      return false;
    }
    // Optional: an older desktop has no window list, which just means "one window".
    setWindows(((await conn.req<unknown[]>('list-instances').catch(() => [])) || []).length);
    return true;
  }, [conn, state]);

  // Only a pull shows the spinner; the refresh every drawer-open does is silent.
  const pullToRefresh = async () => {
    setRefreshing(true);
    const ok = await refresh();
    setRefreshing(false);
    // With rows already on screen the error state can't show, so say it here.
    if (!ok && folders.length) showToast({ message: "Couldn't refresh projects", tone: 'error' });
  };

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
    if (!conn || opening) return;
    haptic.tap();
    setOpening(dir);
    try {
      const r: any = await conn.req('open-folder-path', dir);
      // The desktop wraps handler failures in { error } instead of rejecting.
      if (r?.error) {
        showError('Could not open project', r.error);
        return;
      }
      if (!r?.canceled) setCurrent(r?.repo ?? dir);
      onClose();
    } catch (e: any) {
      showError('Could not open project', e);
    } finally {
      setOpening(null);
    }
  };

  // Drops a project from the desktop's recents list (the same list its File → Open
  // Recent shows). The folder itself is untouched, so this asks for no confirmation;
  // the desktop answers with the trimmed list.
  const removeRecent = async (dir: string) => {
    if (!conn) return;
    try {
      const next = await conn.req<string[]>('remove-recent-folder', dir);
      setFolders(Array.isArray(next) ? next : folders.filter((f) => f !== dir));
      showToast({ message: `Removed ${basename(dir)} from recents`, tone: 'info' });
    } catch (e: any) {
      showError('Could not remove from recents', e);
    }
  };

  const confirmUnpair = async () => {
    const ok = await confirmAction({
      title: 'Unpair this phone?',
      message: 'You will need to scan a new QR code from the desktop to connect again.',
      confirmLabel: 'Unpair',
    });
    if (!ok) return;
    onClose();
    unpair();
  };

  // statusBarTranslucent so the scrim dims the status bar too (see mobile-design.md,
  // "Darkening the screen"); the SafeAreaView measures its own window, so it pads
  // the top back out on its own.
  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.scrim, { opacity: fade }]}>
        <Pressable style={styles.fill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[styles.panel, { width: panelWidth, transform: [{ translateX: slide }] }]}
      >
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Text style={styles.title}>Switch project</Text>
            <Pressable
              hitSlop={11}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close project switcher"
            >
              <Ionicons name="close" size={22} color={color.muted} />
            </Pressable>
          </View>

          <FlatList
            data={folders}
            keyExtractor={(p) => p}
            refreshControl={(
              <RefreshControl
                refreshing={refreshing}
                onRefresh={pullToRefresh}
                tintColor={color.muted}
                colors={[color.accent]}
                progressBackgroundColor={color.raised}
              />
            )}
            contentContainerStyle={folders.length ? undefined : styles.fill}
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
                  disabled={!!opening}
                  accessibilityRole="button"
                  accessibilityLabel={`${basename(item)}${active ? ', current project' : ''}`}
                  accessibilityHint={active ? undefined : 'Opens this project on the desktop'}
                  accessibilityState={{ selected: active, busy: opening === item }}
                >
                  <Ionicons
                    name={active ? 'folder-open' : 'folder-outline'}
                    size={18}
                    color={active ? color.accent : color.muted}
                  />
                  <View style={styles.rowText}>
                    <Text style={[styles.name, active && styles.nameActive]} numberOfLines={1}>
                      {basename(item)}
                    </Text>
                    <Text style={styles.path} numberOfLines={1}>
                      {item}
                    </Text>
                  </View>
                  {opening === item ? (
                    <ActivityIndicator size="small" color={color.accent} style={styles.rowAction} />
                  ) : !active && (
                    // The open project can't be dropped from under itself; every other
                    // row can.
                    <Pressable
                      onPress={() => removeRecent(item)}
                      hitSlop={8}
                      style={styles.rowAction}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${basename(item)} from recents`}
                    >
                      <Ionicons name="close-circle-outline" size={18} color={color.faint} />
                    </Pressable>
                  )}
                </Pressable>
              );
            }}
            ListEmptyComponent={
              loadError ? (
                <ErrorState
                  title="Couldn't load projects"
                  message={loadError}
                  onRetry={refresh}
                />
              ) : !loaded ? (
                <LoadingState label="Loading projects…" />
              ) : (
                <EmptyState
                  icon="folder-open-outline"
                  title="No recent projects"
                  message="Open a folder in the desktop IDE and it shows up here."
                />
              )
            }
          />

          {windows > 1 && (
            <Pressable
              style={({ pressed }) => [styles.footerRow, pressed && styles.rowPressed]}
              onPress={() => { onClose(); switchInstance(); }}
              accessibilityRole="button"
            >
              <Ionicons name="desktop-outline" size={18} color={color.accent} />
              <Text style={styles.switchText}>Switch window ({windows} open)</Text>
            </Pressable>
          )}

          <Pressable
            style={({ pressed }) => [styles.footerRow, pressed && styles.rowPressed]}
            onPress={confirmUnpair}
            accessibilityRole="button"
            accessibilityLabel="Unpair this phone"
          >
            <Ionicons name="log-out-outline" size={18} color={color.red} />
            <Text style={styles.unpairText}>Unpair</Text>
          </Pressable>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

// Whatever landed in a catch block, as one line for the error state.
function errorMessage(e: any): string {
  return e?.message ?? (typeof e === 'string' ? e : 'The desktop did not answer.');
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The scrim is the page colour at 60%, so the dim reads as the app receding rather
  // than as a grey film.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1,4,9,0.6)' },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: color.surface,
    borderRightColor: color.border,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    borderBottomColor: color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { color: color.text, fontSize: 16, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.lg, paddingVertical: 12, minHeight: 56,
  },
  rowActive: { backgroundColor: tint.fill(color.accentDim) },
  rowPressed: { backgroundColor: color.raised },
  rowText: { flex: 1 },
  rowAction: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  name: { color: color.text, fontSize: font.size.md, fontWeight: '600' },
  nameActive: { color: color.accent },
  path: { color: color.muted, fontSize: font.size.xs },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    minHeight: 48,
    borderTopColor: color.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  switchText: { color: color.accent, fontSize: 14, fontWeight: '600' },
  unpairText: { color: color.red, fontSize: 14, fontWeight: '600' },
});
