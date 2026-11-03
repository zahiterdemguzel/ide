// Run panel: the desktop's run toolbar (.vscode/launch.json + tasks.json), plus
// the terminals it opened. Slides in from the right — the mirror of ProjectDrawer,
// so the two side actions bracket the header.
//
// Nothing runs on the phone: starting a config asks the desktop to open it in a
// terminal tab exactly as clicking its toolbar button would (`run-config-start`),
// so the two ends can't drift. A launch config counts as "running" for as long as
// its terminal is open — the same definition the desktop toolbar uses — which is
// why the state here is derived from the live terminal list.
//
// The terminals list also opens a fresh shell (`term-create`), and each terminal
// row can be restarted or killed — see lib/terminals.js for why a config terminal
// restarts through `run-config-start` rather than `term-restart`.
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
import { confirmAction, haptic, showToast } from './feedback';
import { ActionSheet, type SheetAction } from './PromptDialog';
import { forgetTerminal, gridFor, markPhoneOwned, restartPlan } from '../lib/terminals';
import { alpha, color, radius, tint, type as typeRole } from '../theme';

type LaunchConfig = { name: string; compound?: boolean; members?: string[] };
type RunConfigs = { launch: LaunchConfig[]; tasks: { name: string }[] };
type TerminalInfo = { id: string; name: string; kind: string };
type Shell = { name: string; path: string };

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
  const [shellMenu, setShellMenu] = useState<SheetAction[] | null>(null);
  const [creating, setCreating] = useState(false);

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
    try {
      const r = await conn.req<{ ok?: boolean; error?: string } | undefined>('run-config-stop', { name });
      if (r && r.ok === false) showError(`Stop ${name}`, r.error || 'Could not stop this config.');
    } catch (e: any) {
      showError(`Stop ${name}`, e);
    }
  };

  // Deliberately no onClose() here: the panel stays logically open so it's still
  // there when the user backs out of the terminal. While Console has focus the
  // hub hides the modal (App.tsx gates `visible` on the Main screen's focus).
  const openTerminal = (t: TerminalInfo) => {
    navigation.navigate('Console', { id: t.id, name: t.name });
  };

  // New terminal: the desktop's own "+" — one shell opens straight away, several
  // ask which. The shell has no desktop tab (the renderer only shows terminals it
  // created), so it's marked phone-owned and Console sizes it to the phone.
  const createShell = async (shell: Shell) => {
    if (!conn) return;
    setCreating(true);
    try {
      const r = await conn.req<{ id?: string }>('term-create', { shell: shell.path, name: shell.name, kind: 'shell' });
      if (!r?.id) { showError('New terminal', 'The desktop did not open a terminal.'); return; }
      markPhoneOwned(r.id);
      haptic.success();
      openTerminal({ id: r.id, name: shell.name, kind: 'shell' });
    } catch (e: any) {
      showError('New terminal', e);
    } finally {
      setCreating(false);
    }
  };

  const newTerminal = async () => {
    if (!conn || creating) return;
    let shells: Shell[] = [];
    try {
      shells = (await conn.req<Shell[]>('term-shells')) ?? [];
    } catch (e: any) {
      showError('New terminal', e);
      return;
    }
    if (shells.length <= 1) { createShell(shells[0] ?? { name: 'shell', path: '' }); return; }
    setShellMenu(shells.map((sh) => ({
      label: sh.name,
      icon: 'terminal-outline',
      onPress: () => createShell(sh),
    })));
  };

  const restart = async (t: TerminalInfo) => {
    if (!conn) return;
    const plan = restartPlan(t, configs, gridFor(t.id));
    if (!plan) return;
    try {
      const r = await conn.req<{ ok?: boolean; error?: string }>(plan.via, plan.args);
      if (r && r.ok === false) { showError(`Restart ${t.name}`, r.error || 'Could not restart this terminal.'); return; }
      showToast({ message: `Restarted ${t.name}`, tone: 'success' });
    } catch (e: any) {
      showError(`Restart ${t.name}`, e);
    }
  };

  const kill = async (t: TerminalInfo) => {
    if (!conn) return;
    const ok = await confirmAction({
      title: `Kill ${t.name}?`,
      message: 'The process stops and its terminal closes — on the desktop too.',
      confirmLabel: 'Kill',
    });
    if (!ok) return;
    // A send, not a req: main confirms by pushing terminals-changed / term-exit.
    conn.send('term-kill', { id: t.id });
    forgetTerminal(t.id);
  };

  const empty = !configs.launch.length && !configs.tasks.length;

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.scrim, { opacity: fade }]}>
        <Pressable style={styles.fill} onPress={onClose} accessibilityLabel="Close run panel" />
      </Animated.View>
      <Animated.View style={[styles.panel, { width: panelWidth, transform: [{ translateX: slide }] }]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'right']}>
          <View style={styles.header}>
            <Text style={styles.headerTitle} accessibilityRole="header">Run</Text>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.closeBtn, pressed && styles.actionPressed]}
              accessibilityRole="button"
              accessibilityLabel="Close run panel"
            >
              <Ionicons name="close" size={22} color={color.muted} />
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
                    color={live ? color.green : color.muted}
                  />
                  <Text style={[styles.rowName, live && styles.rowNameLive]} numberOfLines={1}>
                    {c.name}
                  </Text>

                  {live && (
                    <Pressable
                      onPress={() => stop(c.name)}
                      style={({ pressed }) => [styles.action, styles.stop, pressed && styles.actionPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Stop ${c.name}`}
                    >
                      <Ionicons name="stop" size={14} color={color.redSoft} />
                    </Pressable>
                  )}

                  {/* Same button start and restart: the desktop reuses the config's
                      existing tab, so a second tap is a rerun. */}
                  <Pressable
                    onPress={() => start('launch', c.name)}
                    disabled={pending}
                    style={({ pressed }) => [styles.action, styles.play, pressed && styles.actionPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={live ? `Restart ${c.name}` : `Run ${c.name}`}
                    accessibilityState={{ busy: pending }}
                  >
                    {pending
                      ? <ActivityIndicator size="small" color={color.green} />
                      : <Ionicons name={live ? 'refresh' : 'play'} size={15} color={color.green} />}
                  </Pressable>
                </View>
              );
            })}

            {!!configs.tasks.length && <Text style={styles.section}>TASKS</Text>}
            {configs.tasks.map((t) => {
              const pending = busy === t.name;
              return (
                <View key={t.name} style={styles.row}>
                  <Ionicons name="construct-outline" size={16} color={color.muted} />
                  <Text style={styles.rowName} numberOfLines={1}>{t.name}</Text>
                  <Pressable
                    onPress={() => start('task', t.name)}
                    disabled={pending}
                    style={({ pressed }) => [styles.action, styles.play, pressed && styles.actionPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Run ${t.name}`}
                    accessibilityState={{ busy: pending }}
                  >
                    {pending
                      ? <ActivityIndicator size="small" color={color.green} />
                      : <Ionicons name="play" size={15} color={color.green} />}
                  </Pressable>
                </View>
              );
            })}

            <View style={styles.sectionRow}>
              <Text style={[styles.section, styles.sectionInRow]}>TERMINALS</Text>
              <Pressable
                onPress={newTerminal}
                disabled={creating}
                style={({ pressed }) => [styles.newTerm, pressed && styles.actionPressed]}
                accessibilityRole="button"
                accessibilityLabel="New terminal"
                accessibilityState={{ busy: creating }}
              >
                {creating
                  ? <ActivityIndicator size="small" color={color.accent} />
                  : <Ionicons name="add" size={18} color={color.accent} />}
                <Text style={styles.newTermLabel}>New</Text>
              </Pressable>
            </View>
            {terminals.length === 0 && <Text style={styles.empty}>No terminals open.</Text>}
            {terminals.map((t) => {
              const canRestart = !!restartPlan(t, configs);
              return (
                <View key={t.id} style={[styles.termRow]}>
                  <Pressable
                    onPress={() => openTerminal(t)}
                    style={({ pressed }) => [styles.termOpen, pressed && styles.rowPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Open terminal ${t.name}`}
                  >
                    <Ionicons
                      name={t.kind === 'config' ? 'terminal' : 'terminal-outline'}
                      size={16}
                      color={t.kind === 'config' ? color.green : color.muted}
                    />
                    <Text style={styles.rowName} numberOfLines={1}>{t.name}</Text>
                  </Pressable>
                  {canRestart && (
                    <Pressable
                      onPress={() => restart(t)}
                      style={({ pressed }) => [styles.action, styles.neutral, pressed && styles.actionPressed]}
                      accessibilityRole="button"
                      accessibilityLabel={`Restart ${t.name}`}
                    >
                      <Ionicons name="refresh" size={15} color={color.muted} />
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => kill(t)}
                    style={({ pressed }) => [styles.action, styles.stop, pressed && styles.actionPressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`Kill ${t.name}`}
                  >
                    <Ionicons name="close" size={16} color={color.redSoft} />
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
      {/* Rendered inside this Modal so it stacks above the panel on both platforms. */}
      <ActionSheet title="New terminal" actions={shellMenu} onClose={() => setShellMenu(null)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: alpha(color.bg, 0.6) },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    backgroundColor: color.surface,
    borderLeftColor: color.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 4,
    borderBottomColor: color.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { color: color.text, fontSize: 16, fontWeight: '700' },
  closeBtn: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  body: { paddingBottom: 24 },
  section: {
    ...typeRole.category, color: color.muted, fontSize: 10, letterSpacing: 0.8,
    paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingRight: 8 },
  sectionInRow: { paddingBottom: 12 },
  newTerm: {
    flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44,
    paddingHorizontal: 10, borderRadius: radius.md,
  },
  newTermLabel: { color: color.accent, fontSize: 13, fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 4, minHeight: 52,
  },
  termRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 12, minHeight: 52,
    borderTopColor: color.borderSoft, borderTopWidth: StyleSheet.hairlineWidth,
  },
  termOpen: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'stretch',
    paddingLeft: 16, paddingRight: 6,
  },
  rowPressed: { backgroundColor: color.raised },
  rowName: { flex: 1, color: color.text, fontSize: 14, fontWeight: '600' },
  rowNameLive: { color: color.green },
  // 44pt targets: a play/stop beside a row is the whole point of the panel.
  action: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  actionPressed: { backgroundColor: color.raisedHi },
  play: { backgroundColor: color.raised, borderColor: alpha(color.green, 0.2) },
  stop: { backgroundColor: color.raised, borderColor: alpha(color.red, 0.2) },
  neutral: { backgroundColor: color.raised, borderColor: color.border },
  empty: { color: color.muted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  error: {
    color: color.redSoft, fontSize: 12, lineHeight: 17,
    marginHorizontal: 16, marginTop: 12, padding: 10,
    backgroundColor: tint.fill(color.red), borderRadius: radius.sm,
    borderWidth: 1, borderColor: alpha(color.red, 0.2),
  },
});
