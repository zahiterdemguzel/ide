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
  ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform,
  Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import MessageView from '../components/chat/MessageView';
import Composer, { Draft } from '../components/chat/Composer';
import BadgeMenu from '../components/chat/BadgeMenu';
import {
  ChatLinks, ChatLinksContext, FileTarget, PathResolver, isDesktopLocalUrl, openUrlFallback,
} from '../components/chat/links';
import StateDot from '../components/StateDot';
import { showError, errorText } from '../components/ErrorDialog';
import { ConnectionBanner, confirmAction, haptic, showToast } from '../components/feedback';
import { Button, ErrorState, LoadingState } from '../components/ui';
import DiffView from '../components/DiffView';
import { allAnswered, conflictPrompt, mergeOutcome, worktreeMode } from '../lib/chat-view';
import { useConnection } from '../api/context';
import {
  Answer, Ask, AskQuestion, Message, Pending, SlashCommand, Transcript,
  answerAsk, dismissAsk, pendingMessage, sendPrompt, settle, uploadImage, upsert,
} from '../api/chat';
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, MODELS, CODEX_MODELS, switchableModels, effortsFor, effortName, setSessionEffort, modelBadgeName,
} from '../api/models';
import { color, font, inset, radius, space, shadow, tint, type, MODAL_TOP_SHIFT } from '../theme';

type DiffStat = { additions: number; deletions: number; files: number };
// Where a worktree session runs and merges back to (from the session row). Empty
// `worktree` is an ordinary session, which commits and reverts in the project tree.
type WorktreeInfo = { worktree: string; branch: string; worktreeState: string };
// An error main reported while this chat was open. `session-error` carries no session
// id (main raises it from whichever session handler threw), so it is shown as "the
// desktop reported", not pinned on this session.
type DesktopError = { key: number; context: string; message: string };

// How many reported errors the chat keeps on screen; older ones are dropped.
const MAX_DESKTOP_ERRORS = 3;

// How long a sent message may stay unconfirmed before we stop showing it. Claude writes
// the transcript entry as soon as the TUI takes the prompt, so this only ever expires
// on a message that never landed — better a bubble that vanishes than a ghost that
// stays forever next to the real one.
const PENDING_TTL_MS = 60_000;

// How far above the end still counts as "at the end". A reader who stopped a few pixels
// short — or a scroll animation that hasn't quite landed — is still following along; only
// a deliberate scroll up should stop the view from tracking the newest message.
const BOTTOM_SLACK = 80;

// How long the revert button stays armed after its first tap, waiting for the
// confirming second one.
const ARM_MS = 3000;

// Whether the software keyboard is up. iOS announces it before it animates (`Will`),
// Android only once it has landed (`Did` — it has no `Will` events).
function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const shown = Keyboard.addListener(showEvent, () => setVisible(true));
    const hidden = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return visible;
}

export default function ChatScreen({ route, navigation }: any) {
  const { id, name } = route.params as { id: string; name?: string };
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const list = useRef<FlatList<Message>>(null);
  // Pushes that raced the snapshot fetch. Every push carries the counter the snapshot
  // reports, so an older copy of a message can't land on top of a newer one.
  const buffered = useRef<{ seq: number; messages: Message[] }[]>([]);
  const ready = useRef(false);
  // The counter of the last push applied. A hole in it means a push was lost (relay
  // hiccup, half-open socket) — the fix is a snapshot refetch, never a stale chat.
  const lastSeq = useRef(0);
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
  // The snapshot fetch failed and nothing has arrived to show instead. Distinct from
  // an empty conversation: "Start the conversation" over a failed fetch is a lie.
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useRef<(() => void) | null>(null);
  const [desktopErrors, setDesktopErrors] = useState<DesktopError[]>([]);
  // The desktop dropped this session to stay under its session limit. Nothing is
  // behind the chat any more, so the composer goes away with it.
  const [evicted, setEvicted] = useState(false);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo>({ worktree: '', branch: '', worktreeState: '' });
  const [merging, setMerging] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [committing, setCommitting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [armed, setArmed] = useState(false);
  const disarm = useRef<ReturnType<typeof setTimeout>>();
  // What this session is running. Both are switchable from their badge in the bar above,
  // and both can also be changed from the desktop (its own badge menu, or a `/model` /
  // `/effort` typed into its terminal) — main pushes either change, so the badges follow.
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState(DEFAULT_EFFORT);

  // Tappable paths and links in the messages. Paths are checked against the desktop
  // (only real files in the open folder become links) and open stacked over the chat.
  const links = useMemo<ChatLinks | null>(() => {
    if (!conn) return null;
    const resolver = new PathResolver(async (paths) => {
      const r = await conn.req<{ resolved?: Record<string, FileTarget> }>('resolve-chat-paths', { id, paths });
      return r?.resolved ?? {};
    });
    return {
      resolver,
      openFile: (target) => navigation.navigate('File', target),
      openUrl: (url) => {
        if (isDesktopLocalUrl(url)) navigation.navigate('Main', { screen: 'Browser', params: { url } });
        else openUrlFallback(url);
      },
    };
  }, [conn, id, navigation]);

  useEffect(() => conn?.on('folder-changed', () => links?.resolver.reset()), [conn, links]);

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

    // The desktop only streams a session's transcript to phones that ask for it —
    // subscribe before fetching, so a message written between the two isn't missed.
    const unwatch = conn.watch('transcript-data', id);

    // Fetch the snapshot and reconcile the pushes that raced it. Also the recovery
    // path: a gap in the push counter re-runs this to fill in what was dropped.
    const load = async () => {
      ready.current = false;
      buffered.current = [];
      try {
        const snap = await conn.req<Transcript>('session-transcript', id);
        if (dropped) return;
        // Merge, don't replace: on a reconnect `messages` already holds rows absorbed
        // before the snapshot resolved, and a blind replace would drop them.
        setMessages((m) => upsert(m, snap.messages || []));
        setPending((p) => settle(p, snap.messages || []));
        setAsk(snap.ask || null);
        let seq = snap.seq ?? 0;
        for (const b of buffered.current) {
          if (b.seq > seq) { absorb(b.messages); seq = b.seq; }
        }
        lastSeq.current = seq;
        if (!dropped) setLoadError(null);
      } catch (e: any) {
        // Live pushes alone still beat a dead screen, so this only becomes an error
        // state if nothing has arrived to show instead (see the render).
        if (!dropped) setLoadError(errorText(e) || 'The desktop did not answer.');
      }
      buffered.current = [];
      ready.current = true;
      if (!dropped) setLoading(false);
    };
    load();
    reload.current = () => { setLoadError(null); setLoading(true); load(); };

    // The list gives us a name but never the state, and the Stop button needs it
    // before the first status push lands. It's also where the session's model and effort
    // come from: neither has a push to wait for until one of them changes.
    conn.req<any[]>('get-sessions').then((all) => {
      const s = all.find((x) => x.id === id);
      if (!s || dropped) return;
      setState(s.state);
      setWorktreeInfo(worktreeOf(s));
      setModel(s.model || DEFAULT_MODEL);
      setEffort(s.effort || DEFAULT_EFFORT);
      if (!name) setTitle(s.name || s.firstPrompt || 'Session');
    }).catch(() => {});
    conn.req<SlashCommand[]>('list-slash-commands').then((c) => !dropped && setCommands(c)).catch(() => {});
    refreshStat();

    const offs = [
      conn.on('transcript-data', (p: any) => {
        if (p.id !== id) return;
        const seq = p.seq ?? 0;
        if (!ready.current) { buffered.current.push({ seq, messages: p.messages }); return; }
        // Not the successor of the last push we applied: one was lost in transit (or
        // the stream restarted under us). Apply what arrived — it's the newest copy —
        // then refetch the snapshot to fill the hole.
        const gap = lastSeq.current > 0 && seq !== lastSeq.current + 1;
        lastSeq.current = seq;
        absorb(p.messages);
        if (gap) load();
      }),
      conn.on('session-ask', (p: any) => { if (p.id === id) setAsk(p.ask); }),
      conn.on('status', (p: any) => { if (p.id === id) setState(p.state); }),
      conn.on('session-name', (p: any) => { if (p.id === id) setTitle(p.name || 'Session'); }),
      conn.on('session-meta', (p: any) => { if (p.id === id) refreshStat(); }),
      conn.on('session-model', (p: any) => { if (p.id === id) setModel(p.model || DEFAULT_MODEL); }),
      conn.on('session-effort', (p: any) => { if (p.id === id) setEffort(p.effort || DEFAULT_EFFORT); }),
      // The whole list, after any change to its shape — including this session's
      // worktree finishing its copy, or going missing.
      conn.on('sessions-changed', (all: any) => {
        const s = Array.isArray(all) ? all.find((x: any) => x?.id === id) : null;
        if (s) setWorktreeInfo(worktreeOf(s));
      }),
      conn.on('session-error', (p: any) => {
        haptic.error();
        setDesktopErrors((prev) => [
          ...prev,
          { key: Date.now() + Math.random(), context: String(p?.context || ''), message: String(p?.message || '') },
        ].slice(-MAX_DESKTOP_ERRORS));
      }),
      conn.on('session-evicted', (p: any) => {
        if (Array.isArray(p?.ids) && p.ids.includes(id)) { setEvicted(true); setAsk(null); }
      }),
    ];
    return () => { dropped = true; reload.current = null; unwatch(); offs.forEach((off) => off?.()); };
  }, [absorb, conn, id, name, refreshStat]);

  const drop = useCallback((uuid: string) => {
    setPending((p) => p.filter((m) => m.uuid !== uuid));
  }, []);
  useEffect(() => () => { expire.current.forEach(clearTimeout); clearTimeout(disarm.current); }, []);

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
    const mine = pendingMessage(text, images.map((img) => img.uri));
    setPending((p) => [...p, mine]);
    expire.current.push(setTimeout(() => drop(mine.uuid), PENDING_TTL_MS));
    atBottom.current = true;
    setSending(true);
    try {
      const paths = [];
      for (const img of images) paths.push(await uploadImage(conn, img.name, img.base64, img.uri));
      // An archived session opens read-only (nothing runs behind it); writing to it is
      // what brings it back. A no-op when the session is already running.
      await conn.req('resume-session', { id, cols: 80, rows: 30 });
      await sendPrompt(conn, id, text, paths);
    } catch (e: any) {
      drop(mine.uuid);
      haptic.error();
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

  // None of the options fit and you don't want to write one either — a fair answer to a
  // question, and better than leaving the session blocked on a card you won't fill in.
  const skip = async () => {
    if (!conn) return;
    const prev = ask;
    setAsk(null);
    try {
      await dismissAsk(conn, id);
    } catch (e: any) {
      setAsk(prev);
      showError('Could not skip the question', e);
    }
  };

  const working = state === 'working';
  const stop = () => { haptic.tap(); conn?.send('pty-input', { id, data: '\x1b' }); };

  // The badge moves on the tap, not on the round trip: main is what actually applies the
  // switch (and pushes it back to every client), but a picker that sat unchanged until
  // the desktop answered would read as a picker that didn't work. A push that disagrees
  // corrects it.
  const pickModel = (m: string) => { setModel(m); conn?.send('set-session-model', { id, model: m }); };
  // Also remembered as the starting level for the next session, the way the model is.
  const pickEffort = (e: string) => { setEffort(e); setSessionEffort(e); conn?.send('set-session-effort', { id, effort: e }); };

  const files = stat ? stat.files : 0;
  const filesLabel = `${files} file${files === 1 ? '' : 's'}`;
  // A worktree session owns its whole checkout, so "commit only this session's hunks"
  // and "revert this session's edits" mean nothing there — Merge replaces both, as it
  // does on the desktop's session bar.
  const wtMode = worktreeMode(worktreeInfo);
  const busyWithGit = committing || reverting || merging;

  const commit = async () => {
    if (busyWithGit || !conn || !files) return;
    if (working && !(await confirmAction({
      title: 'Commit while running?',
      message: 'This session is still running. Its files may still be changing. Commit now anyway?',
      confirmLabel: 'Commit',
      destructive: false,
    }))) return;
    setCommitting(true);
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string }>('commit-session', id);
      if (!r?.ok) { haptic.error(); showError('Commit failed', r?.stderr || 'Commit failed'); }
      else {
        showToast({ message: `Committed ${filesLabel}`, tone: 'success' });
        refreshStat();
      }
    } catch (e: any) {
      haptic.error();
      showError('Commit failed', e);
    } finally {
      setCommitting(false);
    }
  };

  // Revert throws work away, so it takes two taps: the first arms the button and
  // relabels it, the second fires. The arming lapses on its own so a stray tap
  // can't leave a live trigger sitting under the user's thumb. `confirmed` skips
  // the arming for a caller that already asked (the diff sheet's own confirm).
  const revert = async (confirmed = false) => {
    if (busyWithGit || !conn || !files) return;
    if (!armed && !confirmed) {
      haptic.warning();
      setArmed(true);
      clearTimeout(disarm.current);
      disarm.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    clearTimeout(disarm.current);
    setArmed(false);
    setReverting(true);
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string; skipped?: string[] }>('revert-session', id);
      if (!r?.ok) { haptic.error(); showError('Revert failed', r?.stderr || 'Revert failed'); }
      else {
        // A skip isn't a failure — another live session owns those files, and
        // saying nothing would read as "reverted" for changes still on disk.
        if (r.skipped?.length) showError('Some files kept', `Still changed by another session:\n${r.skipped.join('\n')}`);
        else showToast({ message: 'Reverted this session\'s changes', tone: 'success' });
        refreshStat();
      }
    } catch (e: any) {
      haptic.error();
      showError('Revert failed', e);
    } finally {
      setReverting(false);
    }
  };

  // Merge lands commits on the project's branch, so it always asks first (the
  // desktop arms its button for the same reason). A conflict is handed to this
  // session's own agent, which wrote the code — the desktop's hand-off, same prompt.
  const merge = async () => {
    if (busyWithGit || !conn || wtMode !== 'ready') return;
    const running = working || state === 'bg-agents';
    if (!(await confirmAction({
      title: running ? 'Merge while running?' : 'Merge this session?',
      message: (running ? 'This session is still running. Its files may still be changing.\n\n' : '')
        + `Commits the worktree and merges ${worktreeInfo.branch || 'its branch'} into the branch the project has checked out.`,
      confirmLabel: 'Merge',
      destructive: false,
    }))) return;
    setMerging(true);
    let r: any;
    try {
      r = await conn.req('merge-session', id);
    } catch (e: any) {
      r = { ok: false, stderr: errorText(e) };
    } finally {
      setMerging(false);
    }
    const outcome = mergeOutcome(r);
    if (outcome.kind === 'merged') {
      showToast({ message: outcome.message, tone: 'success' });
      setState('pushed');
    } else if (outcome.kind === 'noop') {
      showToast({ message: outcome.message, tone: 'info' });
    } else if (outcome.kind === 'conflict') {
      haptic.error();
      const handOff = await confirmAction({
        title: 'Merge conflict',
        message: `${outcome.message} Let this session resolve it?`,
        confirmLabel: 'Let Claude handle it',
        destructive: false,
      });
      if (handOff) send(conflictPrompt(r), []);
    } else {
      haptic.error();
      showError('Merge failed', outcome.message);
    }
    refreshStat();
  };

  const openDiff = () => { haptic.tap(); setDiffOpen(true); };

  return (
    <ChatLinksContext.Provider value={links}>
      <SafeAreaView style={styles.fill} edges={['top']}>
        <View style={styles.bar}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={10}
            style={styles.back}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
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
                  the same two badges in the same place. The effort badge always names a
                  real level — there is no "Auto" — so what it says is what the session is
                  actually reasoning at. */}
              {/* Only same-family switches are offered (a local model offers none) —
                  main enforces the same lock, this just keeps the menu honest. */}
              <BadgeMenu
                label={modelBadgeName(model)}
                items={switchableModels(model, MODELS.concat(CODEX_MODELS)).filter((m) => m.id !== DEFAULT_MODEL)}
                current={model}
                onPick={pickModel}
                accessibilityLabel="Model"
              />
              <BadgeMenu
                label={effortName(effort, model)}
                items={effortsFor(model)}
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
            accessibilityRole="button"
            accessibilityLabel="Stop Claude"
            accessibilityHint="Interrupts the current turn"
            accessibilityState={{ disabled: !working }}
            style={({ pressed }) => [styles.stop, !working && styles.stopOff, pressed && working && styles.stopPressed]}
          >
            <Ionicons name="stop" size={14} color={working ? color.redSoft : color.faint} />
          </Pressable>
        </View>

        <ConnectionBanner />

        {files > 0 && (
          <View style={styles.actions}>
            {wtMode ? (
              <Pressable
                onPress={merge}
                disabled={busyWithGit || wtMode !== 'ready'}
                accessibilityRole="button"
                accessibilityLabel={worktreeInfo.branch ? `Merge ${worktreeInfo.branch} back into the project` : 'Merge'}
                accessibilityState={{ disabled: busyWithGit || wtMode !== 'ready', busy: merging }}
                style={({ pressed }) => [
                  styles.commit, wtMode !== 'ready' && styles.commitOff, pressed && !merging && styles.commitPressed,
                ]}
              >
                {merging && <ActivityIndicator size="small" color="#fff" />}
                <Ionicons name="git-merge-outline" size={15} color="#fff" />
                <Text style={styles.commitText} numberOfLines={1}>
                  {merging ? 'Merging…'
                    : wtMode === 'missing' ? 'Worktree missing'
                      : wtMode === 'pending' ? 'Worktree not ready'
                        : `Merge ${filesLabel}`}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={commit}
                disabled={busyWithGit}
                accessibilityRole="button"
                accessibilityState={{ disabled: busyWithGit, busy: committing }}
                style={({ pressed }) => [styles.commit, pressed && !committing && styles.commitPressed]}
              >
                {committing && <ActivityIndicator size="small" color="#fff" />}
                <Ionicons name="git-commit-outline" size={15} color="#fff" />
                <Text style={styles.commitText} numberOfLines={1}>
                  {committing ? 'Writing commit message…' : `Commit ${filesLabel}`}
                </Text>
              </Pressable>
            )}
            {/* The diff behind the button: reading what you are about to commit
                shouldn't need the desktop. The counts double as its label. */}
            <Pressable
              onPress={openDiff}
              accessibilityRole="button"
              accessibilityLabel={`Review changes: ${stat?.additions ?? 0} added, ${stat?.deletions ?? 0} removed`}
              style={({ pressed }) => [styles.review, pressed && styles.revertPressed]}
            >
              <Ionicons name="document-text-outline" size={15} color={color.muted} />
              <Text style={styles.reviewAdd}>+{stat?.additions ?? 0}</Text>
              <Text style={styles.reviewDel}>−{stat?.deletions ?? 0}</Text>
            </Pressable>
            {!wtMode && (
              <Pressable
                onPress={() => revert()}
                disabled={busyWithGit}
                accessibilityRole="button"
                accessibilityLabel={armed ? 'Confirm revert' : 'Revert session changes'}
                style={({ pressed }) => [styles.revert, armed && styles.revertArmed, pressed && !reverting && styles.revertPressed]}
              >
                <View style={styles.revertIcon}>
                  {reverting
                    ? <ActivityIndicator size="small" color={color.redSoft} />
                    : <Ionicons name="arrow-undo-outline" size={15} color={color.redSoft} />}
                </View>
                <Text style={styles.revertText}>{armed ? 'Sure?' : 'Revert'}</Text>
              </Pressable>
            )}
          </View>
        )}

        <SessionDiffSheet
          visible={diffOpen}
          sessionId={id}
          onClose={() => setDiffOpen(false)}
          primaryLabel={wtMode ? (wtMode === 'ready' ? `Merge ${filesLabel}` : '') : `Commit ${filesLabel}`}
          primaryIcon={wtMode ? 'git-merge-outline' : 'git-commit-outline'}
          onPrimary={files > 0 && !busyWithGit ? () => { setDiffOpen(false); if (wtMode) merge(); else commit(); } : undefined}
          onRevert={!wtMode && files > 0 && !busyWithGit ? async () => {
            const sure = await confirmAction({
              title: 'Revert this session?',
              message: `Undoes this session's edits to ${filesLabel}. This can't be undone.`,
              confirmLabel: 'Revert',
            });
            if (!sure) return;
            setDiffOpen(false);
            revert(true);
          } : undefined}
        />

        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          {loading && !rows.length ? (
            <LoadingState label="Loading the conversation…" style={styles.fill} />
          ) : loadError && !rows.length ? (
            <ErrorState
              title="Couldn't load this conversation"
              message={loadError}
              onRetry={() => reload.current?.()}
              style={styles.fill}
            />
          ) : (
            <FlatList
              ref={list}
              data={rows}
              keyExtractor={(m) => m.uuid}
              renderItem={({ item }) => <MessageView message={item} pending={(item as Pending).pending} />}
              contentContainerStyle={styles.listBody}
              // The ask card lives in the footer, so its buttons must survive an open
              // keyboard (answering right after typing a custom reply).
              keyboardShouldPersistTaps="handled"
              // Both are "the conversation grew or the room for it shrank": a new message
              // (or the ask card growing the footer), and the keyboard taking the bottom
              // of the screen. Either one leaves the last message above the fold unless
              // we follow it down.
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
              // The ask card scrolls *with* the conversation: it grows to whatever the
              // question needs, and a reader gets back to earlier messages by scrolling
              // the one list — a pinned card would wall them off behind it.
              ListFooterComponent={
                <>
                  {working && <Working />}
                  {desktopErrors.map((err) => (
                    <DesktopErrorCard
                      key={err.key}
                      error={err}
                      onDismiss={() => setDesktopErrors((prev) => prev.filter((x) => x.key !== err.key))}
                    />
                  ))}
                  {evicted && <EvictedCard />}
                  {ask && <AskCard ask={ask} onAnswer={answer} onSkip={skip} />}
                </>
              }
            />
          )}

          <Composer
            commands={commands}
            busy={sending}
            disabled={evicted}
            placeholder={evicted ? 'This session was closed on the desktop'
              : working ? 'Claude is working — send anyway…' : 'Message Claude…'}
            // The screen's SafeAreaView only pads the top; the composer clears the
            // home indicator itself — except while the keyboard covers that strip.
            bottomInset={keyboardVisible ? 0 : insets.bottom}
            onSend={send}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ChatLinksContext.Provider>
  );
}

const STATE_LABEL: Record<string, string> = {
  idle: 'Ready',
  working: 'Working',
  'needs-input': 'Waiting for you',
  completed: 'Done',
  'bg-agents': 'Background agents running',
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
function AskCard({ ask, onAnswer, onSkip }: {
  ask: Ask;
  onAnswer: (answers: Answer[]) => void;
  onSkip: () => void;
}) {
  const [answers, setAnswers] = useState<Answer[]>([]);

  // A new question is a new answer — never carry the last one's into it.
  useEffect(() => { setAnswers([]); }, [ask]);

  const set = (i: number, a: Answer) => {
    setAnswers(ask.questions.map((_, j) => (j === i ? a : answers[j])));
  };

  const single = ask.questions.length === 1;
  const ready = allAnswered(ask.questions.length, answers);

  const label = (i: number) => {
    const a = answers[i];
    if (a?.text) return a.text;
    const keys = a?.keys ?? (a?.key ? [a.key] : []);
    return ask.questions[i].options
      .filter((o) => keys.includes(o.key))
      .map((o) => o.label)
      .join(', ');
  };

  return (
    <View style={styles.ask}>
      <AskCardHeader
        icon="help-circle"
        label={ask.questions.length > 1 ? `Claude is asking · ${ask.questions.length} questions` : 'Claude is asking'}
      />
      <View style={styles.askBody}>
      {ask.questions.map((q, i) => (
        <AskQuestionView
          key={i}
          q={q}
          index={i}
          total={ask.questions.length}
          chosen={answers[i]}
          chosenLabel={label(i)}
          onPick={(a) => set(i, a)}
          // A lone question sends from inside itself, so its Send sits right under
          // the option you just picked.
          onSubmit={single ? (a) => onAnswer([a]) : undefined}
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
      {/* A permission box already says no with its own second option; only Claude's own
          questions need a way out that isn't one of the answers. */}
      {ask.kind === 'question' && (
        <Pressable
          onPress={onSkip}
          style={({ pressed }) => [styles.askBtn, styles.askBtnGhost, styles.askBtnCenter, pressed && styles.askBtnPressed]}
        >
          <Text style={[styles.askBtnText, styles.askSkipText]}>
            {ask.questions.length > 1 ? "Don't answer these" : "Don't answer"}
          </Text>
        </Pressable>
      )}
      </View>
    </View>
  );
}

// The strip every face of the card opens with, so the question list and the
// write-your-own view read as one surface: a green category label — the same
// role the app's NEEDS YOU headers play — over the card body.
function AskCardHeader({ icon, label }: { icon: any; label: string }) {
  return (
    <View style={styles.askCardHead}>
      <Ionicons name={icon} size={15} color={color.green} />
      <Text style={styles.askCardHeadText}>{label.toUpperCase()}</Text>
    </View>
  );
}

// One question. Once it's answered it collapses to its answer, so a card carrying four of
// them doesn't bury the ones still waiting — tap it to change your mind.
//
// Writing your own answer happens *inside* the question rather than on a card-wide view:
// with several questions on the card, taking the card over would unmount the siblings and
// throw away their toggles and their drafts.
//
// Nothing is ever pre-selected, and nothing is sent by tapping an option. A tap
// *selects* (the row tints, its radio fills) and a Send button under the options
// commits — so the screen never shows an answer you didn't give, and a mis-tap on a
// permission prompt's "Yes" can't grant anything by itself. On a card with several
// questions a tap still collapses that question to its answer, and "Send answers"
// commits the lot.
function AskQuestionView({ q, index, total, chosen, chosenLabel, onPick, onSubmit }: {
  q: AskQuestion;
  index: number;
  total: number;
  chosen?: Answer;
  chosenLabel: string;
  onPick: (a: Answer) => void;
  // Set for a card with one question: its own Send answers the whole card.
  onSubmit?: (a: Answer) => void;
}) {
  const [open, setOpen] = useState(true);
  // The single-select option a lone question has selected but not yet sent.
  const [selected, setSelected] = useState<string | null>(null);
  // A multiSelect question can't commit on a tap: the tap is a toggle, and only the
  // reader knows when the set is complete.
  const [picked, setPicked] = useState<string[]>([]);
  // Each question keeps its own draft, so a half-typed answer to one survives while you
  // deal with another.
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const done = Boolean(chosen && (chosen.key || chosen.text || chosen.keys?.length));
  // A new question in the same slot starts unanswered. Keyed on content, not object
  // identity: a snapshot refetch re-sends the same question as a new object, and that
  // must not wipe a choice the reader is halfway through making.
  const questionKey = `${q.question}|${q.options.map((o) => o.key).join(',')}`;
  useEffect(() => { setSelected(null); setPicked([]); }, [questionKey]);

  if (done && !open) {
    return (
      <Pressable
        onPress={() => { if (chosen?.text) { setDraft(chosen.text); setWriting(true); } setOpen(true); }}
        style={styles.askDone}
      >
        <Ionicons name="checkmark-circle" size={16} color={color.green} />
        <View style={styles.askBtnGrow}>
          {total > 1 && <Text style={styles.askHeader}>{q.header || q.question}</Text>}
          <Text style={styles.askDoneText} numberOfLines={2}>{chosenLabel}</Text>
        </View>
        <Ionicons name="chevron-down" size={14} color={color.faint} />
      </Pressable>
    );
  }

  const pick = (a: Answer) => { setOpen(false); setWriting(false); onPick(a); };
  // Commit this question's answer: straight to the desktop on a lone question, or
  // onto the card (collapsing to the answer) when siblings still need theirs.
  const commit = (a: Answer) => {
    haptic.tap();
    if (onSubmit) onSubmit(a); else pick(a);
  };
  const selectedLabel = q.options.find((o) => o.key === selected)?.label;

  return (
    <View style={styles.askGroup}>
      <View>
        {total > 1 && <Text style={styles.askHeader}>{q.header || `Question ${index + 1} of ${total}`}</Text>}
        <Text style={[styles.askText, styles.askTextTight]}>{q.question}</Text>
      </View>
      {writing ? (
        <View style={styles.askOptions}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Tell Claude what you'd rather it did…"
            placeholderTextColor={color.faint}
            style={styles.askInput}
            multiline
            autoFocus
          />
          <View style={styles.askRow}>
            <Pressable
              onPress={() => setWriting(false)}
              style={({ pressed }) => [styles.askBtn, styles.askBtnGhost, pressed && styles.askBtnPressed]}
            >
              <Text style={styles.askBtnText}>Back</Text>
            </Pressable>
            <Pressable
              disabled={!draft.trim()}
              onPress={() => commit({ text: draft.trim() })}
              style={({ pressed }) => [
                styles.askBtn, styles.askBtnPrimary, styles.askBtnGrow, styles.askBtnCenter,
                !draft.trim() && styles.askBtnDim, pressed && styles.askBtnPressed,
              ]}
            >
              <Text style={[styles.askBtnText, styles.askBtnTextPrimary]}>
                {onSubmit ? 'Send answer' : 'Use this answer'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
      <View style={styles.askOptions}>
        {q.options.map((o, i) => {
          // Only what *you* chose is ever tinted — a standing tint on Claude's leading
          // option read as an answer already given.
          const on = q.multiSelect
            ? picked.includes(o.key)
            : onSubmit ? selected === o.key : false;
          const tap = () => {
            if (q.multiSelect) {
              haptic.tap();
              setPicked((p) => (p.includes(o.key) ? p.filter((k) => k !== o.key) : [...p, o.key]));
            } else if (onSubmit) {
              haptic.tap();
              setSelected((cur) => (cur === o.key ? null : o.key));
            } else {
              commit({ key: o.key });
            }
          };
          return (
            <Pressable
              key={o.key}
              onPress={tap}
              accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
              accessibilityState={q.multiSelect ? { checked: on } : { selected: on }}
              style={({ pressed }) => [
                styles.askBtn,
                on && styles.askBtnOn,
                pressed && styles.askBtnPressed,
              ]}
            >
              <View style={styles.askBtnRow}>
                {(q.multiSelect || onSubmit) && (
                  <Ionicons
                    name={q.multiSelect
                      ? (on ? 'checkbox' : 'square-outline')
                      : (on ? 'radio-button-on' : 'radio-button-off')}
                    size={16}
                    color={on ? color.green : color.muted}
                  />
                )}
                <Text style={[styles.askBtnText, styles.askBtnGrow, on && styles.askBtnTextOn]}>
                  {o.label}
                </Text>
              </View>
              {!!o.description && (
                <Text style={styles.askDesc}>
                  {o.description}
                </Text>
              )}
            </Pressable>
          );
        })}
        {q.multiSelect && (
          <Pressable
            disabled={!picked.length}
            onPress={() => commit({ keys: picked })}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.askBtn, styles.askBtnCenter,
              !!onSubmit && styles.askBtnPrimary,
              !picked.length && styles.askBtnDim, pressed && styles.askBtnPressed,
            ]}
          >
            <Text style={[styles.askBtnText, !!onSubmit && styles.askBtnTextPrimary]}>
              {!picked.length ? 'Select one or more'
                : onSubmit ? `Send ${picked.length} selected` : `Choose ${picked.length} selected`}
            </Text>
          </Pressable>
        )}
        {!q.multiSelect && !!onSubmit && (
          <Pressable
            disabled={!selected}
            onPress={() => selected && commit({ key: selected })}
            accessibilityRole="button"
            accessibilityState={{ disabled: !selected }}
            style={({ pressed }) => [
              styles.askBtn, styles.askBtnPrimary, styles.askBtnCenter,
              !selected && styles.askBtnDim, pressed && styles.askBtnPressed,
            ]}
          >
            <Text style={[styles.askBtnText, styles.askBtnTextPrimary]} numberOfLines={1}>
              {selectedLabel ? `Send: ${selectedLabel}` : 'Pick an answer'}
            </Text>
          </Pressable>
        )}
        {!!q.customKey && (
          <Pressable
            onPress={() => setWriting(true)}
            style={({ pressed }) => [styles.askBtn, styles.askBtnRow, pressed && styles.askBtnPressed]}
          >
            <Text style={[styles.askBtnText, styles.askBtnGrow]}>
              {draft.trim() ? 'Keep writing my own answer' : 'Write my own answer'}
            </Text>
            <Ionicons name="create-outline" size={14} color={color.muted} />
          </Pressable>
        )}
      </View>
      )}
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

// The worktree fields of a session row (get-sessions / sessions-changed).
function worktreeOf(s: any): WorktreeInfo {
  return { worktree: s?.worktree || '', branch: s?.branch || '', worktreeState: s?.worktreeState || '' };
}

// An error the desktop reported while the chat was open — the session failing to
// spawn, save, commit… Without it a failure on the desktop leaves the chat looking
// merely idle. The full text (often a stack) opens in the copyable error dialog.
function DesktopErrorCard({ error, onDismiss }: { error: DesktopError; onDismiss: () => void }) {
  const firstLine = error.message.split('\n')[0] || 'Unknown error';
  const title = error.context ? `Error ${error.context}` : 'The desktop reported an error';
  return (
    <View style={styles.notice} accessibilityRole="alert">
      <Ionicons name="alert-circle" size={18} color={color.red} />
      <Pressable
        style={styles.noticeBody}
        onPress={() => showError(title, error.message)}
        accessibilityRole="button"
        accessibilityHint="Shows the full error, which you can copy"
      >
        <Text style={styles.noticeTitle}>{title}</Text>
        <Text style={styles.noticeText} numberOfLines={2}>{firstLine}</Text>
        <Text style={styles.noticeLink}>Show details</Text>
      </Pressable>
      <Pressable onPress={onDismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss error">
        <Ionicons name="close" size={16} color={color.muted} />
      </Pressable>
    </View>
  );
}

function EvictedCard() {
  return (
    <View style={styles.notice} accessibilityRole="alert">
      <Ionicons name="archive-outline" size={18} color={color.red} />
      <View style={styles.noticeBody}>
        <Text style={styles.noticeTitle}>This session was closed on the desktop</Text>
        <Text style={styles.noticeText}>
          The desktop removed it to stay under its session limit. Start a new session to keep going.
        </Text>
      </View>
    </View>
  );
}

// The session's whole diff — what Commit (or Merge) is about to land — full screen,
// with the action at the bottom so you can read and then commit in one place.
function SessionDiffSheet({
  visible, sessionId, onClose, primaryLabel, primaryIcon, onPrimary, onRevert,
}: {
  visible: boolean;
  sessionId: string;
  onClose: () => void;
  primaryLabel: string;
  primaryIcon: any;
  onPrimary?: () => void;
  onRevert?: () => void;
}) {
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<DiffStat | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!conn) return;
    setPatch(null);
    setError(null);
    try {
      const r = await conn.req<{ ok: boolean; patch: string } & DiffStat>('session-diff', sessionId);
      if (!r?.ok) { setError('The desktop could not read this session\'s changes.'); return; }
      setPatch(r.patch || '');
      setTotals({ additions: r.additions, deletions: r.deletions, files: r.files });
    } catch (e: any) {
      setError(errorText(e) || 'The desktop did not answer.');
    }
  }, [conn, sessionId]);

  // Read fresh on every open: the session may have edited more since the last look.
  useEffect(() => { if (visible) fetchDiff(); }, [visible, fetchDiff]);

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingTop: Math.max(insets.top, inset.minTop) + MODAL_TOP_SHIFT }]}>
        <View style={styles.sheetBar}>
          <View style={styles.titleWrap}>
            <Text style={styles.title}>Session changes</Text>
            {totals && (
              <Text style={styles.statusText}>
                {totals.files} file{totals.files === 1 ? '' : 's'}
                {'  '}<Text style={styles.reviewAdd}>+{totals.additions}</Text>
                {' '}<Text style={styles.reviewDel}>−{totals.deletions}</Text>
              </Text>
            )}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={styles.sheetClose}
            accessibilityRole="button"
            accessibilityLabel="Close changes"
          >
            <Ionicons name="close" size={20} color={color.text} />
          </Pressable>
        </View>
        <View style={styles.fill}>
          {error ? (
            <ErrorState title="Couldn't load the changes" message={error} onRetry={fetchDiff} />
          ) : patch === null ? (
            <LoadingState label="Reading the diff…" />
          ) : (
            <DiffView patch={patch} emptyLabel="This session has no uncommitted changes" />
          )}
        </View>
        {(onPrimary || onRevert) && (
          <View style={[styles.sheetFooter, { paddingBottom: insets.bottom + space.sm }]}>
            {onRevert && (
              <Button label="Revert" icon="arrow-undo-outline" tone="secondary" onPress={onRevert} />
            )}
            {onPrimary && !!primaryLabel && (
              <Button label={primaryLabel} icon={primaryIcon} onPress={onPrimary} style={styles.fill} />
            )}
          </View>
        )}
      </View>
    </Modal>
  );
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

  actions: { flexDirection: 'row', alignItems: 'stretch', gap: space.sm, marginHorizontal: space.md, marginTop: 10 },

  // A banner, not a bar: it floats over the transcript with the green shadow every
  // commit action in the system carries.
  commit: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    paddingVertical: 11, borderRadius: 12, backgroundColor: color.greenDeep,
    ...shadow.button,
  },
  commitPressed: { backgroundColor: color.green },
  commitOff: { opacity: 0.55 },
  commitText: { color: '#fff', fontSize: font.size.sm, fontWeight: '700' },

  // Outlined, not filled: reverting is the destructive twin of commit, and it
  // shouldn't compete with it for the tap.
  revert: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs,
    paddingHorizontal: space.md, paddingVertical: 11, borderRadius: 12,
    backgroundColor: color.raised, borderWidth: 1, borderColor: tint.line(color.red),
  },
  // The diff button: its +/− counts are its label, as on the desktop's Diff badge.
  review: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingHorizontal: 10, minHeight: 44, borderRadius: 12,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  reviewAdd: { color: color.green, fontSize: font.size.xs, fontWeight: '700', fontVariant: ['tabular-nums'] },
  reviewDel: { color: color.red, fontSize: font.size.xs, fontWeight: '700', fontVariant: ['tabular-nums'] },
  revertArmed: { backgroundColor: tint.line(color.red), borderColor: color.red },
  revertPressed: { backgroundColor: color.raisedHi },
  // Fixed slots, both of them: this button flexes with its content and Commit takes
  // the rest of the row, so a narrower label ("Sure?") or a wider glyph (the spinner)
  // would slide the Commit button sideways under a thumb already on its way down.
  // The width is the resting label's, the wider of the two.
  revertIcon: { width: 15, alignItems: 'center' },
  revertText: { minWidth: 48, textAlign: 'center', color: color.redSoft, fontSize: font.size.sm, fontWeight: '700' },

  listBody: { paddingVertical: space.md, flexGrow: 1 },

  working: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  workingText: { color: color.muted, fontSize: font.size.sm },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { color: color.text, fontSize: font.size.lg, fontWeight: '700' },
  emptyText: { color: color.muted, fontSize: font.size.sm, textAlign: 'center', lineHeight: 20 },

  // A desktop error or an evicted session: the system's red tint trio, inline in the
  // conversation where the reader is already looking.
  notice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.md, marginVertical: space.xs,
    padding: space.md, borderRadius: 12,
    backgroundColor: tint.fill(color.red), borderWidth: 1, borderColor: tint.line(color.red),
  },
  noticeBody: { flex: 1, gap: 2 },
  noticeTitle: { color: color.redSoft, fontSize: font.size.sm, fontWeight: '700', lineHeight: 18 },
  noticeText: { color: color.body, fontSize: font.size.xs, lineHeight: 16, fontFamily: font.mono },
  noticeLink: { color: color.accent, fontSize: font.size.xs, fontWeight: '600', marginTop: 2 },

  sheet: { flex: 1, backgroundColor: color.bg },
  sheetBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: space.lg, paddingVertical: 10,
    backgroundColor: color.surfaceDeep,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft,
  },
  sheetClose: {
    width: 36, height: 36, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', backgroundColor: color.raised,
  },
  sheetFooter: {
    flexDirection: 'row', gap: space.sm,
    paddingHorizontal: space.md, paddingTop: space.sm,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border,
  },

  // The one card in the app that glows: a blocked session is the only thing here
  // that is actively waiting on you. It lives at the tail of the transcript and takes
  // whatever height its question needs — the chat scrolls, the card never does.
  ask: {
    marginHorizontal: space.md, marginTop: space.xs, marginBottom: space.sm,
    backgroundColor: color.surface,
    borderWidth: 1, borderColor: tint.glowLine(color.green),
    borderRadius: radius.card,
    overflow: 'hidden',
    shadowColor: color.green, shadowOpacity: 0.07, shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 }, elevation: 3,
  },
  askCardHead: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: tint.fill(color.green),
    borderBottomWidth: 1, borderBottomColor: tint.line(color.green),
  },
  askCardHeadText: { ...type.category, color: color.green },
  askBody: { padding: 14, gap: space.md },
  askGroup: { gap: space.md },
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
  askBtn: {
    paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  // The send CTA is the solid green every commit action carries; a *selected option*
  // is the system's tint trio instead (wash fill, stronger line, solid text), so a
  // choice reads as a state, not a second send button.
  askBtnPrimary: { backgroundColor: color.greenDeep, borderColor: color.greenDeep },
  askBtnOn: { backgroundColor: tint.fillStrong(color.green), borderColor: tint.line(color.green) },
  askBtnTextOn: { color: color.green },
  askBtnDim: { opacity: 0.45 },
  askBtnGhost: { backgroundColor: 'transparent' },
  askSkipText: { color: color.muted },
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
