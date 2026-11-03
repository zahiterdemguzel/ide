// Live view of one desktop terminal — the tab a launch config or task is running
// in (or a plain shell). Same PTY the desktop is showing, so output streams to
// both and anything typed here lands in the same shell.
//
// Two things this deliberately does NOT do:
//   - resize a desktop terminal's PTY. It is also open in a desktop tab, sized for
//     the desktop; resizing it to phone width would reflow the view under the
//     person sitting at the machine. Instead the phone pins its xterm to the PTY's
//     grid (see attach) and shrinks the font to fit. The one exception is a shell
//     the phone itself opened (the Run panel's New terminal — see lib/terminals.js):
//     no desktop tab shows it, so nothing can fight over its size, and it is sized
//     once to the phone's own fitted grid — readable text instead of 80 columns
//     squeezed across a phone.
//   - own the terminal. Unlike a Claude session (which the phone claims so two
//     people can't type into one PTY), a run terminal is a shared shell; both ends
//     stay live, exactly as two panes onto one tmux window would.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import XtermWebView, { TERMINAL_BG, XtermHandle } from '../components/XtermWebView';
import { ConnectionBanner } from '../components/feedback';
import { useConnection } from '../api/context';
import { isPhoneOwned, rememberGrid } from '../lib/terminals';
import { alpha, color, font, inset, radius } from '../theme';

type Snapshot = { data: string; seq: number; cols?: number; rows?: number };

export default function ConsoleTerminal({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const sizedToPhone = useRef(false);
  const term = useRef<XtermHandle>(null);
  const buffered = useRef<{ seq: number; data: string }[]>([]);
  const ready = useRef(false);
  const attaching = useRef(false);
  const [exited, setExited] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState('');

  // Typing goes through a native input bar, not xterm's hidden textarea: mobile
  // IMEs (Android especially) feed the WebView composition events that xterm
  // mangles or drops, so keystrokes typed "into" the terminal never reliably reach
  // the PTY. A native TextInput has none of that — the line lands whole, and the
  // Enter is part of the same write, exactly as a desktop keystroke sequence would.
  const sendLine = () => {
    conn?.send('term-input', { id, data: input + '\r' });
    setInput('');
    term.current?.toBottom();
  };

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
      // Pin the terminal to the PTY's grid *before* replaying: the retained bytes
      // were painted for those dimensions, and replaying them into a phone-fitted
      // terminal puts every cursor move in the wrong cell (text over text).
      if (snap?.cols && snap?.rows) term.current?.setDims(snap.cols, snap.rows);
      if (snap?.data) write(snap.data);
      seq = snap?.seq ?? 0;
    } catch { /* offline — live output alone beats a dead screen */ }
    for (const c of buffered.current) if (c.seq > seq) write(c.data);
    buffered.current = [];
    ready.current = true;
    attaching.current = false;
  }, [conn, id, write]);

  useEffect(() => {
    // Terminal bytes are a watched stream: the desktop sends this terminal's output
    // only while a screen showing it asks for it.
    const unwatch = conn?.watch('term-data', id);
    const offs = [
      conn?.on('term-data', (p: any) => {
        if (p.id !== id) return;
        if (!ready.current) { buffered.current.push({ seq: p.seq ?? 0, data: p.data }); return; }
        write(p.data);
      }),
      // The shell exited, or the config was stopped from either end. Keep the output
      // on screen — it's usually the error you came to read.
      conn?.on('term-exit', (p: any) => { if (p.id === id) setExited(true); }),
      // The PTY was resized at the desktop (or restarted under the same id) — follow
      // it, since the byte stream is painted for exactly that grid.
      conn?.on('term-resized', (p: any) => {
        if (p.id === id && p.cols && p.rows) term.current?.setDims(p.cols, p.rows);
      }),
    ];
    return () => { unwatch?.(); offs.forEach((off) => off?.()); };
  }, [conn, id, write]);

  const toggleSelect = () => {
    const on = !selecting;
    setSelecting(on);
    term.current?.setSelect(on);
  };

  // xterm reports its phone-fitted grid first, before onReady starts the attach;
  // for a phone-owned shell that's the size to give the PTY. Sent ahead of the
  // scrollback request on the same socket, so the snapshot already carries it.
  const onResize = (cols: number, rows: number) => {
    if (!isPhoneOwned(id) || sizedToPhone.current || !cols || !rows) return;
    sizedToPhone.current = true;
    rememberGrid(id, cols, rows);
    conn?.send('term-resize', { id, cols, rows });
  };

  const onCopy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={styles.fill}>
      <View style={[styles.bar, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.chipPressed]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={color.text} />
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
          hitSlop={{ top: 6, bottom: 6 }}
          style={({ pressed }) => [styles.chip, selecting && styles.chipOn, pressed && styles.chipPressed]}
          accessibilityRole="switch"
          accessibilityState={{ checked: selecting }}
          accessibilityLabel="Select text"
        >
          <Ionicons name="text-outline" size={14} color={selecting ? color.accent : color.muted} />
          <Text style={[styles.chipText, selecting && styles.chipTextOn]}>Select</Text>
        </Pressable>

        <Pressable
          onPress={() => term.current?.copy()}
          hitSlop={{ top: 6, bottom: 6 }}
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          accessibilityRole="button"
          accessibilityLabel={selecting ? 'Copy selection' : 'Copy terminal output'}
        >
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? color.green : color.muted} />
          <Text style={[styles.chipText, copied && styles.chipTextDone]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ConnectionBanner />

      {selecting && (
        <Text style={styles.hint}>
          Long-press to select, then Copy (or use the system menu). Paused at this snapshot — live
          output resumes when you turn Select off.
        </Text>
      )}

      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <XtermWebView
          ref={term}
          onInput={(data) => conn?.send('term-input', { id, data })}
          onResize={onResize}
          onReady={attach}
          onCopy={onCopy}
        />
        {!exited && (
          <View style={styles.inputBar}>
            {/* Ctrl+C — the one control key a shared shell needs from a phone:
                stopping the running command without killing the whole terminal. */}
            <Pressable
              onPress={() => conn?.send('term-input', { id, data: '\x03' })}
              style={({ pressed }) => [styles.ctrlBtn, pressed && styles.chipPressed]}
              accessibilityRole="button"
              accessibilityLabel="Send Control-C"
              accessibilityHint="Interrupts the running command"
            >
              <Text style={styles.ctrlText}>^C</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={sendLine}
              placeholder="Type a command…"
              placeholderTextColor={color.muted}
              autoCapitalize="none"
              autoCorrect={false}
              blurOnSubmit={false}
              returnKeyType="send"
              accessibilityLabel="Command"
            />
            <Pressable
              onPress={sendLine}
              style={({ pressed }) => [styles.sendBtn, pressed && styles.sendPressed]}
              accessibilityRole="button"
              accessibilityLabel="Send command"
            >
              <Ionicons name="arrow-up" size={18} color={color.text} />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
      {/* A pushed screen clears the home indicator itself. Outside the keyboard
          view, so the keyboard's own overlap isn't counted twice. */}
      <View style={{ height: insets.bottom, backgroundColor: exited ? TERMINAL_BG : color.surface }} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: TERMINAL_BG },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 4, paddingBottom: 4,
    backgroundColor: color.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  titleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: color.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  exited: {
    color: color.muted, fontSize: 10, fontWeight: '700',
    backgroundColor: color.raised, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
    overflow: 'hidden',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, height: 34, borderRadius: radius.sm,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  chipOn: { borderColor: alpha(color.accent, 0.4), backgroundColor: alpha(color.accentDim, 0.13) },
  chipPressed: { backgroundColor: color.raisedHi },
  chipText: { color: color.muted, fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: color.accent },
  chipTextDone: { color: color.green },
  hint: {
    color: color.muted, fontSize: 11, paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: color.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border,
  },
  inputBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 6,
    backgroundColor: color.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border,
  },
  ctrlBtn: {
    minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  ctrlText: { color: color.muted, fontSize: 13, fontWeight: '700', fontFamily: font.mono },
  input: {
    flex: 1, color: color.text, fontSize: 13, fontFamily: font.mono, minHeight: 44,
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border, borderRadius: radius.sm,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: radius.sm,
    backgroundColor: color.accentDim, alignItems: 'center', justifyContent: 'center',
  },
  sendPressed: { opacity: 0.85 },
});
