// Live terminal for one Claude session (XtermWebView does the rendering).
// pty-data events stream in; keystrokes go back over the `pty-input` send channel
// — the same wire format the desktop renderer uses.
//
// Above it sits the session bar: Stop (ESC, like the desktop's interrupt key —
// enabled only while the session is working, the one state that has a turn to
// interrupt) and the desktop's "Commit N files" button, backed by the same
// session-diff-stat / commit-session channels.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Alert, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import XtermWebView, { XtermHandle } from '../components/XtermWebView';
import { useConnection } from '../api/context';

type DiffStat = { additions: number; deletions: number; files: number };
type Snapshot = { data: string; seq: number };

export default function SessionTerminal({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const term = useRef<XtermHandle>(null);
  const buffered = useRef<{ seq: number; data: string }[]>([]);
  const ready = useRef(false);
  const attaching = useRef(false);
  const [title, setTitle] = useState(name || 'Session');
  const [state, setState] = useState<string>('idle');
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [committing, setCommitting] = useState(false);

  const refreshStat = useCallback(async () => {
    if (!conn) return;
    try { setStat(await conn.req<DiffStat>('session-diff-stat', id)); } catch { /* offline */ }
  }, [conn, id]);

  const write = useCallback((data: string) => term.current?.write(data), []);

  // Navigating away destroys the WebView, so a reopened session comes back with an
  // empty terminal — nothing above the cursor to scroll up to. Replay the output main
  // retained for us before going live. Chunks that raced the snapshot are already in
  // it, so drop them: main stamps the snapshot and every pty-data with one counter.
  const attach = useCallback(async () => {
    if (ready.current || attaching.current || !conn) return;
    attaching.current = true;
    let seq = 0;
    try {
      const snap = await conn.req<Snapshot>('session-scrollback', id);
      if (snap?.data) write(snap.data);
      seq = snap?.seq ?? 0;
    } catch { /* offline — live output alone is better than a dead screen */ }
    for (const c of buffered.current) if (c.seq > seq) write(c.data);
    buffered.current = [];
    ready.current = true;
    attaching.current = false;
  }, [conn, id, write]);

  useEffect(() => {
    refreshStat();
    // The list passes a name for an instant title, but never the state — and the
    // commit-while-running guard needs it before the first status push arrives.
    conn?.req<any[]>('get-sessions')
      .then((list) => {
        const s = list.find((x) => x.id === id);
        if (!s) return;
        setState(s.state);
        if (!name) setTitle(s.name || s.firstPrompt || 'Session');
      })
      .catch(() => {});
    const offs = [
      conn?.on('pty-data', (p: any) => {
        if (p.id !== id) return;
        if (!ready.current) { buffered.current.push({ seq: p.seq ?? 0, data: p.data }); return; }
        write(p.data);
      }),
      conn?.on('status', (p: any) => { if (p.id === id) setState(p.state); }),
      conn?.on('session-name', (p: any) => { if (p.id === id) setTitle(p.name || 'Session'); }),
      // main re-pushes session-meta whenever a session's tracked files change (and
      // after a commit clears them), so the file count tracks the same signal the
      // desktop's commit button does.
      conn?.on('session-meta', (p: any) => { if (p.id === id) refreshStat(); }),
    ];
    return () => offs.forEach((off) => off?.());
  }, [conn, id, name, refreshStat, write]);

  // Hold the session for as long as this screen is open. The desktop covers it while
  // we do, so the two of us can't type into the same PTY at once. Leaving the screen
  // (or dropping the socket — main handles that end) hands it back.
  useEffect(() => {
    if (!conn) return;
    conn.send('session-control', { id, on: true });
    return () => { conn.send('session-control', { id, on: false }); };
  }, [conn, id]);

  // ESC: the desktop's interrupt key. It goes down the same pty-input channel a
  // keystroke would, so Claude stops the turn exactly as it does locally. Only a
  // `working` session has a turn to interrupt — main ignores the ESC otherwise
  // (interruptState in hook-events.js), so offering the button would be a lie.
  const running = state === 'working';
  const terminate = () => conn?.send('pty-input', { id, data: '\x1b' });

  const files = stat ? stat.files : 0;
  const commit = async () => {
    if (committing || !conn) return;
    if (state === 'working' && !(await confirmWorking())) return;
    setCommitting(true);
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string }>('commit-session', id);
      if (!r?.ok) Alert.alert('Commit failed', r?.stderr || 'Commit failed');
      else refreshStat(); // session-meta also lands, but don't wait on it
    } catch (e: any) {
      Alert.alert('Commit failed', e?.message ?? String(e));
    } finally {
      setCommitting(false);
    }
  };

  const commitLabel = committing
    ? 'Writing commit message…'
    : files ? `Commit ${files} file${files > 1 ? 's' : ''}` : 'Nothing to commit';
  const commitDisabled = committing || files === 0;

  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <View style={styles.bar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={20} color="#e6edf3" />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Pressable
          onPress={terminate}
          disabled={!running}
          hitSlop={10}
          style={({ pressed }) => [
            styles.stopBtn,
            !running && styles.stopBtnOff,
            pressed && running && styles.stopBtnPressed,
          ]}
        >
          <Ionicons name="stop" size={14} color={running ? '#ffa198' : '#6e7681'} />
          <Text style={[styles.stopText, !running && styles.stopTextOff]}>Stop</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={commit}
        disabled={commitDisabled}
        style={({ pressed }) => [
          styles.commitBtn,
          commitDisabled && styles.commitBtnOff,
          pressed && !commitDisabled && styles.commitBtnPressed,
        ]}
      >
        {committing && <ActivityIndicator size="small" color="#7d8590" style={styles.spinner} />}
        <Text style={[styles.commitText, commitDisabled && styles.commitTextOff]}>{commitLabel}</Text>
      </Pressable>

      <XtermWebView
        ref={term}
        onInput={(data) => conn?.send('pty-input', { id, data })}
        onResize={(cols, rows) => conn?.send('pty-resize', { id, cols, rows })}
        onReady={attach}
      />
    </SafeAreaView>
  );
}

// The session is still running (yellow); its file set may be mid-change, so
// confirm before committing a moving target — same guard as the desktop.
function confirmWorking(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Commit while running?',
      'This session is still running. Its files may still be changing. Commit now anyway?',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Commit', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e1e' },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 8, paddingVertical: 8,
    backgroundColor: '#161b22', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#30363d',
  },
  iconBtn: { padding: 4 },
  title: { flex: 1, color: '#e6edf3', fontSize: 15, fontWeight: '600' },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    backgroundColor: '#21262d', borderWidth: 1, borderColor: '#f8514933',
  },
  stopBtnPressed: { backgroundColor: '#30363d' },
  stopBtnOff: { backgroundColor: 'transparent', borderColor: '#30363d' },
  stopText: { color: '#ffa198', fontSize: 13, fontWeight: '600' },
  stopTextOff: { color: '#6e7681' },
  commitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, backgroundColor: '#238636',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#30363d',
  },
  commitBtnPressed: { backgroundColor: '#2ea043' },
  commitBtnOff: { backgroundColor: '#21262d' },
  commitText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  commitTextOff: { color: '#7d8590' },
  spinner: { marginRight: 2 },
});
