// Live view of one desktop terminal — the tab a launch config or task is running
// in (or a plain shell). Same PTY the desktop is showing, so output streams to
// both and anything typed here lands in the same shell.
//
// Two things this deliberately does NOT do:
//   - resize the PTY. This terminal is also open in a desktop tab, sized for the
//     desktop; resizing it to phone width would reflow the view under the person
//     sitting at the machine. Instead we leave the PTY's dimensions alone and let
//     xterm soft-wrap the long lines to the phone's width. TUI output looks a bit
//     loose; log output — which is what a launch config produces — reads fine.
//   - own the terminal. Unlike a Claude session (which the phone claims so two
//     people can't type into one PTY), a run terminal is a shared shell; both ends
//     stay live, exactly as two panes onto one tmux window would.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import XtermWebView, { XtermHandle } from '../components/XtermWebView';
import { useConnection } from '../api/context';

type Snapshot = { data: string; seq: number };

export default function ConsoleTerminal({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const term = useRef<XtermHandle>(null);
  const buffered = useRef<{ seq: number; data: string }[]>([]);
  const ready = useRef(false);
  const attaching = useRef(false);
  const [exited, setExited] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [copied, setCopied] = useState(false);

  const write = useCallback((data: string) => term.current?.write(data), []);

  // The terminal has been running on the desktop, possibly for a while: replay what
  // main retained before going live, and drop the live chunks that raced the
  // snapshot (main stamps both with one counter).
  const attach = useCallback(async () => {
    if (ready.current || attaching.current || !conn) return;
    attaching.current = true;
    let seq = 0;
    try {
      const snap = await conn.req<Snapshot>('term-scrollback', id);
      if (snap?.data) write(snap.data);
      seq = snap?.seq ?? 0;
    } catch { /* offline — live output alone beats a dead screen */ }
    for (const c of buffered.current) if (c.seq > seq) write(c.data);
    buffered.current = [];
    ready.current = true;
    attaching.current = false;
  }, [conn, id, write]);

  useEffect(() => {
    const offs = [
      conn?.on('term-data', (p: any) => {
        if (p.id !== id) return;
        if (!ready.current) { buffered.current.push({ seq: p.seq ?? 0, data: p.data }); return; }
        write(p.data);
      }),
      // The shell exited, or the config was stopped from either end. Keep the output
      // on screen — it's usually the error you came to read.
      conn?.on('term-exit', (p: any) => { if (p.id === id) setExited(true); }),
    ];
    return () => offs.forEach((off) => off?.());
  }, [conn, id, write]);

  const toggleSelect = () => {
    const on = !selecting;
    setSelecting(on);
    term.current?.setSelect(on);
  };

  const onCopy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <View style={styles.bar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={20} color="#e6edf3" />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text>
          {exited && <Text style={styles.exited}>exited</Text>}
        </View>

        {/* Select mode lays a plain-text copy of the buffer over the terminal, which
            is the only way the platform's long-press selection works at all — see
            XtermWebView. It's a snapshot, so it reads as a mode rather than a gesture
            competing with the scroll. */}
        <Pressable
          onPress={toggleSelect}
          hitSlop={8}
          style={({ pressed }) => [styles.chip, selecting && styles.chipOn, pressed && styles.chipPressed]}
        >
          <Ionicons name="text-outline" size={14} color={selecting ? '#4da3ff' : '#7d8590'} />
          <Text style={[styles.chipText, selecting && styles.chipTextOn]}>Select</Text>
        </Pressable>

        <Pressable
          onPress={() => term.current?.copy()}
          hitSlop={8}
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        >
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? '#3fb950' : '#7d8590'} />
          <Text style={[styles.chipText, copied && styles.chipTextDone]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>

      {selecting && (
        <Text style={styles.hint}>
          Long-press to select, then Copy (or use the system menu). Paused at this snapshot — live
          output resumes when you turn Select off.
        </Text>
      )}

      <XtermWebView
        ref={term}
        onInput={(data) => conn?.send('term-input', { id, data })}
        onReady={attach}
        onCopy={onCopy}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e1e' },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 8,
    backgroundColor: '#161b22', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#30363d',
  },
  iconBtn: { padding: 4 },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: '#e6edf3', fontSize: 15, fontWeight: '600', flexShrink: 1 },
  exited: {
    color: '#7d8590', fontSize: 10, fontWeight: '700',
    backgroundColor: '#21262d', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    overflow: 'hidden',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6,
    backgroundColor: '#21262d', borderWidth: 1, borderColor: '#30363d',
  },
  chipOn: { borderColor: '#4da3ff66', backgroundColor: '#1f6feb22' },
  chipPressed: { backgroundColor: '#30363d' },
  chipText: { color: '#7d8590', fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: '#4da3ff' },
  chipTextDone: { color: '#3fb950' },
  hint: {
    color: '#7d8590', fontSize: 11, paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: '#161b22', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#30363d',
  },
});
