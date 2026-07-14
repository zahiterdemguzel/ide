// One Claude session, as a conversation.
//
// The phone deliberately has no terminal: what you get is a chat — messages, a
// composer, images, slash commands. The messages are Claude Code's own transcript
// (main tails it — src/main/chat.js), not the TUI's output, so this screen never
// parses ANSI and never shows a cursor.
//
// The one thing a chat can't express on its own is a *question the TUI is asking*
// (a permission prompt). Main lifts it out of the PTY and pushes it as `session-ask`;
// it lands here as a card above the composer, and its answer goes back as the
// keystroke the menu expects. Without that, a session waiting for permission would
// look idle forever.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  Pressable, StyleSheet, Text, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import MessageView from '../components/chat/MessageView';
import Composer, { Draft } from '../components/chat/Composer';
import { useConnection } from '../api/context';
import { Ask, Message, SlashCommand, Transcript, answerAsk, sendPrompt, uploadImage, upsert } from '../api/chat';
import { color, font, radius, space, stateColor } from '../theme';

type DiffStat = { additions: number; deletions: number; files: number };

export default function ChatScreen({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const list = useRef<FlatList<Message>>(null);
  // Pushes that raced the snapshot fetch. Every push carries the counter the snapshot
  // reports, so an older copy of a message can't land on top of a newer one.
  const buffered = useRef<{ seq: number; messages: Message[] }[]>([]);
  const ready = useRef(false);
  const atBottom = useRef(true);

  const [messages, setMessages] = useState<Message[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [title, setTitle] = useState(name || 'Session');
  const [state, setState] = useState<string>('idle');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [committing, setCommitting] = useState(false);

  const refreshStat = useCallback(async () => {
    if (!conn) return;
    try { setStat(await conn.req<DiffStat>('session-diff-stat', id)); } catch { /* offline */ }
  }, [conn, id]);

  useEffect(() => {
    if (!conn) return;
    let dropped = false;

    (async () => {
      try {
        const snap = await conn.req<Transcript>('session-transcript', id);
        if (dropped) return;
        setMessages(snap.messages || []);
        setAsk(snap.ask || null);
        for (const b of buffered.current) if (b.seq > (snap.seq ?? 0)) setMessages((m) => upsert(m, b.messages));
      } catch { /* offline: live pushes alone still beat a dead screen */ }
      buffered.current = [];
      ready.current = true;
      if (!dropped) setLoading(false);
    })();

    // The list gives us a name but never the state, and the Stop button needs it
    // before the first status push lands.
    conn.req<any[]>('get-sessions').then((all) => {
      const s = all.find((x) => x.id === id);
      if (!s || dropped) return;
      setState(s.state);
      if (!name) setTitle(s.name || s.firstPrompt || 'Session');
    }).catch(() => {});
    conn.req<SlashCommand[]>('list-slash-commands').then((c) => !dropped && setCommands(c)).catch(() => {});
    refreshStat();

    const offs = [
      conn.on('transcript-data', (p: any) => {
        if (p.id !== id) return;
        if (!ready.current) { buffered.current.push({ seq: p.seq ?? 0, messages: p.messages }); return; }
        setMessages((m) => upsert(m, p.messages));
      }),
      conn.on('session-ask', (p: any) => { if (p.id === id) setAsk(p.ask); }),
      conn.on('status', (p: any) => { if (p.id === id) setState(p.state); }),
      conn.on('session-name', (p: any) => { if (p.id === id) setTitle(p.name || 'Session'); }),
      conn.on('session-meta', (p: any) => { if (p.id === id) refreshStat(); }),
    ];
    return () => { dropped = true; offs.forEach((off) => off?.()); };
  }, [conn, id, name, refreshStat]);

  // Hold the session while this screen is open, exactly as the terminal used to: the
  // desktop covers it, so the two of us can't type into one prompt.
  useEffect(() => {
    if (!conn) return;
    conn.send('session-control', { id, on: true });
    return () => { conn.send('session-control', { id, on: false }); };
  }, [conn, id]);

  // Follow the conversation while the reader is at the bottom of it — but never yank
  // the view down while they are reading further up.
  const scrollToEnd = useCallback(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  }, []);

  const send = async (text: string, images: Draft[]) => {
    if (!conn) return;
    setSending(true);
    try {
      const paths = [];
      for (const img of images) paths.push(await uploadImage(conn, img.name, img.base64));
      await sendPrompt(conn, id, text, paths);
      atBottom.current = true;
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? String(e));
    } finally {
      setSending(false);
    }
  };

  const working = state === 'working';
  const stop = () => conn?.send('pty-input', { id, data: '\x1b' });

  const files = stat ? stat.files : 0;
  const commit = async () => {
    if (committing || !conn || !files) return;
    if (working && !(await confirmWorking())) return;
    setCommitting(true);
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string }>('commit-session', id);
      if (!r?.ok) Alert.alert('Commit failed', r?.stderr || 'Commit failed');
      else refreshStat();
    } catch (e: any) {
      Alert.alert('Commit failed', e?.message ?? String(e));
    } finally {
      setCommitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.fill} edges={['top']}>
      <View style={styles.bar}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color={color.text} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: stateColor[state] || color.faint }]} />
            <Text style={styles.statusText}>{STATE_LABEL[state] || state}</Text>
          </View>
        </View>
        <Pressable
          onPress={stop}
          disabled={!working}
          hitSlop={10}
          style={({ pressed }) => [styles.stop, !working && styles.stopOff, pressed && working && styles.stopPressed]}
        >
          <Ionicons name="stop" size={14} color={working ? color.redSoft : color.faint} />
        </Pressable>
      </View>

      {files > 0 && (
        <Pressable
          onPress={commit}
          disabled={committing}
          style={({ pressed }) => [styles.commit, pressed && !committing && styles.commitPressed]}
        >
          {committing && <ActivityIndicator size="small" color="#fff" />}
          <Ionicons name="git-commit-outline" size={15} color="#fff" />
          <Text style={styles.commitText}>
            {committing ? 'Writing commit message…' : `Commit ${files} file${files > 1 ? 's' : ''}`}
          </Text>
        </Pressable>
      )}

      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={color.muted} /></View>
        ) : (
          <FlatList
            ref={list}
            data={messages}
            keyExtractor={(m) => m.uuid}
            renderItem={({ item }) => <MessageView message={item} />}
            contentContainerStyle={styles.listBody}
            onContentSizeChange={scrollToEnd}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
            }}
            scrollEventThrottle={200}
            keyboardDismissMode="interactive"
            ListEmptyComponent={<Empty />}
            ListFooterComponent={working ? <Working /> : null}
          />
        )}

        {ask && (
          <AskCard
            ask={ask}
            onAnswer={(key) => { if (conn) answerAsk(conn, id, key); setAsk(null); }}
          />
        )}

        <Composer
          commands={commands}
          busy={sending}
          placeholder={working ? 'Claude is working — send anyway…' : 'Message Claude…'}
          onSend={send}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  working: 'Working',
  'needs-input': 'Waiting for you',
  completed: 'Done',
  interrupted: 'Interrupted',
  pushed: 'Committed',
};

// The permission prompt, as a card. Answering is a keystroke — the TUI menu takes the
// option's number — so the card is the menu, redrawn as buttons.
function AskCard({ ask, onAnswer }: { ask: Ask; onAnswer: (key: string) => void }) {
  return (
    <View style={styles.ask}>
      <View style={styles.askHead}>
        <Ionicons name="help-circle" size={16} color={color.green} />
        <Text style={styles.askText}>{ask.question}</Text>
      </View>
      <View style={styles.askOptions}>
        {ask.options.map((o, i) => (
          <Pressable
            key={o.key}
            onPress={() => onAnswer(o.key)}
            style={({ pressed }) => [styles.askBtn, i === 0 && styles.askBtnPrimary, pressed && styles.askBtnPressed]}
          >
            <Text style={[styles.askBtnText, i === 0 && styles.askBtnTextPrimary]} numberOfLines={2}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Working() {
  return (
    <View style={styles.working}>
      <ActivityIndicator size="small" color={color.yellow} />
      <Text style={styles.workingText}>Claude is working…</Text>
    </View>
  );
}

function Empty() {
  return (
    <View style={styles.empty}>
      <Ionicons name="sparkles-outline" size={28} color={color.faint} />
      <Text style={styles.emptyTitle}>Start the conversation</Text>
      <Text style={styles.emptyText}>
        Ask Claude to build, explain or fix something. Attach a screenshot with +, or type / for a command.
      </Text>
    </View>
  );
}

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
  fill: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.sm, paddingVertical: space.sm,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border,
  },
  back: { padding: space.xs },
  titleWrap: { flex: 1 },
  title: { color: color.text, fontSize: font.size.md, fontWeight: '600' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  statusText: { color: color.muted, fontSize: font.size.xs },
  stop: {
    width: 34, height: 34, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raised, borderWidth: 1, borderColor: '#f8514933',
  },
  stopPressed: { backgroundColor: color.raisedHi },
  stopOff: { backgroundColor: 'transparent', borderColor: color.border },

  commit: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    paddingVertical: 10, backgroundColor: color.greenDeep,
  },
  commitPressed: { backgroundColor: color.green },
  commitText: { color: '#fff', fontSize: font.size.sm, fontWeight: '700' },

  listBody: { paddingVertical: space.md, flexGrow: 1 },

  working: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  workingText: { color: color.muted, fontSize: font.size.sm },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { color: color.text, fontSize: font.size.lg, fontWeight: '700' },
  emptyText: { color: color.muted, fontSize: font.size.sm, textAlign: 'center', lineHeight: 20 },

  ask: {
    margin: space.md, padding: space.md,
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: '#3fb95055',
    borderRadius: radius.md,
    gap: space.md,
  },
  askHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  askText: { flex: 1, color: color.text, fontSize: font.size.sm, lineHeight: 19, fontWeight: '600' },
  askOptions: { gap: space.sm },
  askBtn: {
    paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.sm,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  askBtnPrimary: { backgroundColor: color.greenDeep, borderColor: color.greenDeep },
  askBtnPressed: { opacity: 0.8 },
  askBtnText: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  askBtnTextPrimary: { color: '#fff' },
});
