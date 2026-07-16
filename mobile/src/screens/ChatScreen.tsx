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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import MessageView from '../components/chat/MessageView';
import Composer, { Draft } from '../components/chat/Composer';
import BadgeMenu from '../components/chat/BadgeMenu';
import StateDot from '../components/StateDot';
import { showError } from '../components/ErrorDialog';
import { useConnection } from '../api/context';
import {
  Answer, Ask, AskQuestion, Message, Pending, SlashCommand, Transcript,
  answerAsk, pendingMessage, sendPrompt, settle, uploadImage, upsert,
} from '../api/chat';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, MODELS, effortName, modelBadgeName,
} from '../api/models';
import { color, font, radius, space, shadow, tint } from '../theme';

type DiffStat = { additions: number; deletions: number; files: number };

// How long a sent message may stay unconfirmed before we stop showing it. Claude writes
// the transcript entry as soon as the TUI takes the prompt, so this only ever expires
// on a message that never landed — better a bubble that vanishes than a ghost that
// stays forever next to the real one.
const PENDING_TTL_MS = 60_000;

// How far above the end still counts as "at the end". A reader who stopped a few pixels
// short — or a scroll animation that hasn't quite landed — is still following along; only
// a deliberate scroll up should stop the view from tracking the newest message.
const BOTTOM_SLACK = 80;

export default function ChatScreen({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const list = useRef<FlatList<Message>>(null);
  // Pushes that raced the snapshot fetch. Every push carries the counter the snapshot
  // reports, so an older copy of a message can't land on top of a newer one.
  const buffered = useRef<{ seq: number; messages: Message[] }[]>([]);
  const ready = useRef(false);
  const atBottom = useRef(true);
  const expire = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [messages, setMessages] = useState<Message[]>([]);
  // What we've sent but not yet seen come back. They're shown at the tail of the list,
  // so tapping send puts your words on screen at once instead of after a round trip.
  const [pending, setPending] = useState<Pending[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [title, setTitle] = useState(name || 'Session');
  const [state, setState] = useState<string>('idle');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [committing, setCommitting] = useState(false);
  // What this session is running. Both are switchable from their badge in the bar above,
  // and both can also be changed from the desktop (its own badge menu, or a `/model` /
  // `/effort` typed into its terminal) — main pushes either change, so the badges follow.
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);

  const refreshStat = useCallback(async () => {
    if (!conn) return;
    try { setStat(await conn.req<DiffStat>('session-diff-stat', id)); } catch { /* offline */ }
  }, [conn, id]);

  // Every message that arrives from the desktop also settles the pending copies: the
  // transcript's own entry for a message we sent replaces the one we drew ourselves.
  const absorb = useCallback((incoming: Message[]) => {
    setMessages((m) => upsert(m, incoming));
    setPending((p) => settle(p, incoming));
  }, []);

  useEffect(() => {
    if (!conn) return;
    let dropped = false;
    // This effect re-runs on every reconnect (a new `conn`). Re-arm the buffering gate:
    // without resetting `ready`, pushes during the new snapshot fetch would bypass the
    // seq gate and the in-flight snapshot would then replace them — wiping the newest
    // message until some later push repeated it.
    ready.current = false;
    buffered.current = [];

    (async () => {
      try {
        const snap = await conn.req<Transcript>('session-transcript', id);
        if (dropped) return;
        // Merge, don't replace: on a reconnect `messages` already holds rows absorbed
        // before the snapshot resolved, and a blind replace would drop them.
        setMessages((m) => upsert(m, snap.messages || []));
        setPending((p) => settle(p, snap.messages || []));
        setAsk(snap.ask || null);
        for (const b of buffered.current) if (b.seq > (snap.seq ?? 0)) absorb(b.messages);
      } catch { /* offline: live pushes alone still beat a dead screen */ }
      buffered.current = [];
      ready.current = true;
      if (!dropped) setLoading(false);
    })();

    // The list gives us a name but never the state, and the Stop button needs it
    // before the first status push lands. It's also where the session's model and effort
    // come from: neither has a push to wait for until one of them changes.
    conn.req<any[]>('get-sessions').then((all) => {
      const s = all.find((x) => x.id === id);
      if (!s || dropped) return;
      setState(s.state);
      setModel(s.model || DEFAULT_MODEL);
      setEffort(s.effort || DEFAULT_EFFORT);
      if (!name) setTitle(s.name || s.firstPrompt || 'Session');
    }).catch(() => {});
    conn.req<SlashCommand[]>('list-slash-commands').then((c) => !dropped && setCommands(c)).catch(() => {});
    refreshStat();

    const offs = [
      conn.on('transcript-data', (p: any) => {
        if (p.id !== id) return;
        if (!ready.current) { buffered.current.push({ seq: p.seq ?? 0, messages: p.messages }); return; }
        absorb(p.messages);
      }),
      conn.on('session-ask', (p: any) => { if (p.id === id) setAsk(p.ask); }),
      conn.on('status', (p: any) => { if (p.id === id) setState(p.state); }),
      conn.on('session-name', (p: any) => { if (p.id === id) setTitle(p.name || 'Session'); }),
      conn.on('session-meta', (p: any) => { if (p.id === id) refreshStat(); }),
      conn.on('session-model', (p: any) => { if (p.id === id) setModel(p.model || DEFAULT_MODEL); }),
      conn.on('session-effort', (p: any) => { if (p.id === id) setEffort(p.effort || DEFAULT_EFFORT); }),
    ];
    return () => { dropped = true; offs.forEach((off) => off?.()); };
  }, [absorb, conn, id, name, refreshStat]);

  const drop = useCallback((uuid: string) => {
    setPending((p) => p.filter((m) => m.uuid !== uuid));
  }, []);
  useEffect(() => () => { expire.current.forEach(clearTimeout); }, []);

  // Follow the conversation while the reader is at the bottom of it — but never yank
  // the view down while they are reading further up.
  const scrollToEnd = useCallback(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  }, []);

  const rows = useMemo(() => (pending.length ? [...messages, ...pending] : messages), [messages, pending]);

  // The bubble goes up first and the wire runs behind it. Uploading the photos, typing
  // the prompt into the TUI and waiting for Claude to write the transcript takes a
  // second or two; none of that is a reason for the reader to watch their own message
  // disappear into nothing. If the send fails, the bubble goes away with the alert.
  const send = async (text: string, images: Draft[]) => {
    if (!conn) return;
    const mine = pendingMessage(text, images.length);
    setPending((p) => [...p, mine]);
    expire.current.push(setTimeout(() => drop(mine.uuid), PENDING_TTL_MS));
    atBottom.current = true;
    setSending(true);
    try {
      const paths = [];
      for (const img of images) paths.push(await uploadImage(conn, img.name, img.base64));
      await sendPrompt(conn, id, text, paths);
    } catch (e: any) {
      drop(mine.uuid);
      showError('Could not send', e);
    } finally {
      setSending(false);
    }
  };

  // The card goes the moment it is answered: the keystroke settles the menu, and a
  // question you have already answered has no business still sitting on screen while
  // the desktop catches up.
  const answer = async (answers: Answer[]) => {
    if (!conn) return;
    const prev = ask;
    setAsk(null);
    try {
      await answerAsk(conn, id, answers);
    } catch (e: any) {
      // The answer never reached the desktop, so the session is still blocked on the
      // question — put the card back rather than stranding it unanswerable.
      setAsk(prev);
      showError('Could not answer', e);
    }
  };

  const working = state === 'working';
  const stop = () => conn?.send('pty-input', { id, data: '\x1b' });

  // The badge moves on the tap, not on the round trip: main is what actually applies the
  // switch (and pushes it back to every client), but a picker that sat unchanged until
  // the desktop answered would read as a picker that didn't work. A push that disagrees
  // corrects it.
  const pickModel = (m: string) => { setModel(m); conn?.send('set-session-model', { id, model: m }); };
  const pickEffort = (e: string) => { setEffort(e); conn?.send('set-session-effort', { id, effort: e }); };

  const files = stat ? stat.files : 0;
  const commit = async () => {
    if (committing || !conn || !files) return;
    if (working && !(await confirmWorking())) return;
    setCommitting(true);
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string }>('commit-session', id);
      if (!r?.ok) showError('Commit failed', r?.stderr || 'Commit failed');
      else refreshStat();
    } catch (e: any) {
      showError('Commit failed', e);
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
            <View style={styles.dotSlot}>
              <StateDot state={state} />
            </View>
            <Text style={styles.statusText} numberOfLines={1}>{STATE_LABEL[state] || state}</Text>
            {/* What the session is running, and where you change it. The desktop keeps
                the same two badges in the same place. Effort names "Auto" here even
                though that's the default — a badge you can tap has to say what it is. */}
            <BadgeMenu
              label={modelBadgeName(model)}
              items={MODELS.filter((m) => m.id !== DEFAULT_MODEL)}
              current={model}
              onPick={pickModel}
              accessibilityLabel="Model"
            />
            <BadgeMenu
              label={effortName(effort)}
              items={EFFORTS}
              current={effort || DEFAULT_EFFORT}
              onPick={pickEffort}
              accessibilityLabel="Reasoning effort"
            />
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
            data={rows}
            keyExtractor={(m) => m.uuid}
            renderItem={({ item }) => <MessageView message={item} pending={(item as Pending).pending} />}
            contentContainerStyle={styles.listBody}
            // Both are "the conversation grew or the room for it shrank": a new message,
            // and the keyboard or the ask card taking the bottom of the screen. Either
            // one leaves the last message above the fold unless we follow it down.
            onContentSizeChange={scrollToEnd}
            onLayout={scrollToEnd}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - BOTTOM_SLACK;
            }}
            // The flag decides whether the *next* message yanks the view; reading it a
            // fifth of a second late is how a reader who just scrolled up gets pulled
            // back down anyway. Track the scroll as it happens.
            scrollEventThrottle={16}
            keyboardDismissMode="interactive"
            ListEmptyComponent={<Empty />}
            ListFooterComponent={working ? <Working /> : null}
          />
        )}

        {ask && <AskCard ask={ask} onAnswer={answer} />}

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

// The question the session is blocked on, as a card. Claude can ask several at once, so
// the card holds an answer per question and sends them together — the terminal's own box
// works the same way (pick, pick, submit), and answering half of it would leave the
// session stuck on the rest.
//
// A permission prompt is the same card with one question and two answers. Its options are
// only ever Yes and No: the terminal also offers "yes, and stop asking this session", but
// that one is a standing grant, and a phone is the wrong place to hand one out.
function AskCard({ ask, onAnswer }: { ask: Ask; onAnswer: (answers: Answer[]) => void }) {
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [writingTo, setWritingTo] = useState<number | null>(null);
  const [reply, setReply] = useState('');
  // The card yields to the conversation, never the other way around: cap it well under
  // half the screen so the transcript behind it stays readable and scrollable, and let
  // anything past the cap scroll *inside* the card. The inner ScrollView also owns the
  // touch handoff — a drag that starts on an option becomes a scroll, not a tap.
  const { height } = useWindowDimensions();
  const maxHeight = Math.round(height * 0.45);

  // A new question is a new answer — never carry the last one's into it.
  useEffect(() => { setAnswers([]); setWritingTo(null); setReply(''); }, [ask]);

  const set = (i: number, a: Answer) => {
    const next = ask.questions.map((_, j) => (j === i ? a : answers[j]));
    setAnswers(next);
    // A single question with nothing else to fill in is answered by the tap itself:
    // making the user then press Send would be a button for its own sake.
    if (ask.questions.length === 1) onAnswer(next);
  };

  const answered = (i: number) => {
    const a = answers[i];
    return Boolean(a && (a.key || a.text));
  };
  const ready = ask.questions.every((_, i) => answered(i));

  const label = (i: number) => {
    const a = answers[i];
    if (a?.text) return a.text;
    return ask.questions[i].options.find((o) => o.key === a?.key)?.label ?? '';
  };

  if (writingTo !== null) {
    const q = ask.questions[writingTo];
    return (
      <View style={[styles.ask, { maxHeight }]}>
        <ScrollView
          bounces={false}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.askBody}
        >
        <View style={styles.askHead}>
          <Ionicons name="create-outline" size={16} color={color.green} />
          <Text style={styles.askText}>{q.question}</Text>
        </View>
        <TextInput
          value={reply}
          onChangeText={setReply}
          placeholder="Tell Claude what you'd rather it did…"
          placeholderTextColor={color.faint}
          style={styles.askInput}
          multiline
          autoFocus
        />
        <View style={styles.askRow}>
          <Pressable
            onPress={() => { setWritingTo(null); setReply(''); }}
            style={({ pressed }) => [styles.askBtn, styles.askBtnGhost, pressed && styles.askBtnPressed]}
          >
            <Text style={styles.askBtnText}>Back</Text>
          </Pressable>
          <Pressable
            disabled={!reply.trim()}
            onPress={() => { const i = writingTo; setWritingTo(null); setReply(''); set(i, { text: reply.trim() }); }}
            style={({ pressed }) => [
              styles.askBtn, styles.askBtnPrimary, styles.askBtnGrow, styles.askBtnCenter,
              !reply.trim() && styles.askBtnDim, pressed && styles.askBtnPressed,
            ]}
          >
            <Text style={[styles.askBtnText, styles.askBtnTextPrimary]}>Use this answer</Text>
          </Pressable>
        </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.ask, { maxHeight }]}>
      <ScrollView
        bounces={false}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.askBody}
      >
      {ask.questions.map((q, i) => (
        <AskQuestionView
          key={`${q.header}:${q.question}`}
          q={q}
          index={i}
          total={ask.questions.length}
          chosen={answers[i]}
          chosenLabel={label(i)}
          onPick={(a) => set(i, a)}
          onWrite={() => { setReply(''); setWritingTo(i); }}
        />
      ))}
      {ask.questions.length > 1 && (
        <Pressable
          disabled={!ready}
          onPress={() => onAnswer(answers)}
          style={({ pressed }) => [
            styles.askBtn, styles.askBtnPrimary, styles.askBtnCenter,
            !ready && styles.askBtnDim, pressed && styles.askBtnPressed,
          ]}
        >
          <Text style={[styles.askBtnText, styles.askBtnTextPrimary]}>
            {ready ? 'Send answers' : `Answer all ${ask.questions.length} questions`}
          </Text>
        </Pressable>
      )}
      </ScrollView>
    </View>
  );
}

// One question. Once it's answered it collapses to its answer, so a card carrying four of
// them doesn't bury the ones still waiting — tap it to change your mind.
function AskQuestionView({ q, index, total, chosen, chosenLabel, onPick, onWrite }: {
  q: AskQuestion;
  index: number;
  total: number;
  chosen?: Answer;
  chosenLabel: string;
  onPick: (a: Answer) => void;
  onWrite: () => void;
}) {
  const [open, setOpen] = useState(true);
  const done = Boolean(chosen && (chosen.key || chosen.text));

  if (done && !open) {
    return (
      <Pressable onPress={() => setOpen(true)} style={styles.askDone}>
        <Ionicons name="checkmark-circle" size={16} color={color.green} />
        <View style={styles.askBtnGrow}>
          {total > 1 && <Text style={styles.askHeader}>{q.header || q.question}</Text>}
          <Text style={styles.askDoneText} numberOfLines={2}>{chosenLabel}</Text>
        </View>
        <Ionicons name="chevron-down" size={14} color={color.faint} />
      </Pressable>
    );
  }

  const pick = (a: Answer) => { setOpen(false); onPick(a); };

  return (
    <View style={styles.askGroup}>
      <View style={styles.askHead}>
        <Ionicons name={index === 0 ? 'help-circle' : 'ellipse-outline'} size={16} color={color.green} />
        <View style={styles.askBtnGrow}>
          {total > 1 && <Text style={styles.askHeader}>{q.header || `Question ${index + 1} of ${total}`}</Text>}
          <Text style={[styles.askText, styles.askTextTight]}>{q.question}</Text>
        </View>
      </View>
      <View style={styles.askOptions}>
        {q.options.map((o, i) => (
          <Pressable
            key={o.key}
            onPress={() => pick({ key: o.key })}
            style={({ pressed }) => [
              styles.askBtn,
              i === 0 && styles.askBtnPrimary,
              pressed && styles.askBtnPressed,
            ]}
          >
            <Text style={[styles.askBtnText, i === 0 && styles.askBtnTextPrimary]}>
              {o.label}
            </Text>
            {!!o.description && (
              <Text style={[styles.askDesc, i === 0 && styles.askDescPrimary]} numberOfLines={3}>
                {o.description}
              </Text>
            )}
          </Pressable>
        ))}
        {!!q.customKey && (
          <Pressable
            onPress={onWrite}
            style={({ pressed }) => [styles.askBtn, styles.askBtnRow, pressed && styles.askBtnPressed]}
          >
            <Text style={[styles.askBtnText, styles.askBtnGrow]}>Write my own answer</Text>
            <Ionicons name="create-outline" size={14} color={color.muted} />
          </Pressable>
        )}
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

  // The gradient the tabs' ScreenHeader draws is overkill for a bar this short —
  // its far end alone reads the same against the transcript below.
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.md, paddingVertical: 10,
    backgroundColor: color.surfaceDeep,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft,
  },
  back: { padding: space.xs },
  titleWrap: { flex: 1 },
  title: { color: color.text, fontSize: 16, fontWeight: '700' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  // Fixed slot: the working ring is wider than the resting dot, and without this the
  // status label would nudge sideways every time a session started or stopped.
  dotSlot: { width: 11, alignItems: 'center' },
  // The state label gives up its room to the badges rather than pushing them off the bar.
  statusText: { flexShrink: 1, color: color.muted, fontSize: font.size.xs },
  stop: {
    width: 36, height: 36, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raised, borderWidth: 1, borderColor: tint.line(color.red),
  },
  stopPressed: { backgroundColor: color.raisedHi },
  stopOff: { backgroundColor: 'transparent', borderColor: color.border },

  // A banner, not a bar: it floats over the transcript with the green shadow every
  // commit action in the system carries.
  commit: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    marginHorizontal: space.md, marginTop: 10,
    paddingVertical: 11, borderRadius: 12, backgroundColor: color.greenDeep,
    ...shadow.button,
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

  // The one card in the app that glows: a blocked session is the only thing here
  // that is actively waiting on you.
  ask: {
    marginHorizontal: space.md, marginBottom: 10,
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: tint.glowLine(color.green),
    borderRadius: radius.card,
    overflow: 'hidden',
    shadowColor: color.green, shadowOpacity: 0.07, shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 }, elevation: 3,
  },
  // The scrollable inside of the card: the padding and gap live here so the card's
  // rounded border clips the content instead of the content overflowing it.
  askBody: { padding: 14, gap: space.md },
  askGroup: { gap: space.md },
  askHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  askText: { flex: 1, color: color.text, fontSize: font.size.sm, lineHeight: 19, fontWeight: '600' },
  // The same question text when it sits inside a column that already flexes — `flex: 1`
  // there would collapse the line instead of wrapping it.
  askTextTight: { flex: 0 },
  askHeader: { color: color.faint, fontSize: font.size.xs, fontWeight: '600', marginBottom: 2 },
  askOptions: { gap: space.sm },
  askDone: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  askDoneText: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  askDesc: { color: color.muted, fontSize: font.size.xs, lineHeight: 16, marginTop: 3 },
  askDescPrimary: { color: 'rgba(255,255,255,0.75)' },
  askBtn: {
    paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  askBtnPrimary: { backgroundColor: color.greenDeep, borderColor: color.greenDeep },
  askBtnDim: { opacity: 0.45 },
  askBtnGhost: { backgroundColor: 'transparent' },
  askBtnPressed: { opacity: 0.8 },
  askBtnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  askBtnGrow: { flex: 1 },
  askBtnText: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  askBtnTextPrimary: { color: '#fff' },
  askBtnCenter: { alignItems: 'center' },
  askRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  askInput: {
    color: color.text, fontSize: font.size.sm, lineHeight: 20,
    minHeight: 68, maxHeight: 140,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    textAlignVertical: 'top',
    backgroundColor: color.raised,
    borderWidth: 1, borderColor: color.border, borderRadius: radius.sm,
  },
});
