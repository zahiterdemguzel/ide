// Git pane: status, a file's diff, stage/unstage, discard, branch switch/create, commit,
// push/pull, the ⋯ menu (fetch, amend, undo, force push, clean, GitHub hand-offs) and
// stashes. Mirrors the desktop git pane (src/renderer/git-pane.js) and its git-* IPC
// channels (same payload shapes as src/main/git.js). Destructive actions the desktop
// arms with a two-click confirm use a destructive confirm here — there's no
// hover-to-arm on touch.
//
// Results come back as a toast (with a haptic) on success and an error dialog with
// git's stderr on failure. Anything run from a sheet closes the sheet first: neither
// a toast nor the error dialog can show over an open Modal.
import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View, Text, SectionList, FlatList, Pressable, TextInput, ActivityIndicator,
  KeyboardAvoidingView, Linking, Platform, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import { newSessionWithPrompt } from '../api/session-prompt';
import CommitHistory from '../components/CommitHistory';
import DiffSheet, { type DiffSheetAction } from '../components/DiffSheet';
import FileIcon from '../components/FileIcon';
import { ActionList, Sheet, useAfterDismiss, type SheetAction } from '../components/GitSheets';
import StashSheet from '../components/GitStash';
import ScreenHeader, { ChromeContext, NoProject } from '../components/ScreenHeader';
import {
  CategoryLabel, Divider, EmptyState, ErrorState, IconButton, LoadingState, StatusBadge,
} from '../components/ui';
import { showError } from '../components/ErrorDialog';
import { confirmAction, haptic, showToast } from '../components/feedback';
import {
  checkoutName, normalizeBranchName, prCreateMessage, replyUrl, syncSuccessMessage,
} from '../lib/git-actions';
import { color, radius, font, shadow, tint } from '../theme';

type Entry = { status: string; file: string };
type Status = {
  ok: boolean; error?: string; staged: Entry[]; unstaged: Entry[]; conflicts: Entry[];
  branch?: string; ahead?: number; behind?: number;
};
type Branch = { name: string; remote: boolean };
type Res = {
  ok: boolean; stdout?: string; stderr?: string; needsMerge?: boolean;
  url?: string; existing?: boolean; clean?: boolean;
};
// Which list a changed file was tapped in — decides its diff bucket and its actions.
type FileTarget = { entry: Entry; staged: boolean; conflict: boolean };

// Copy for the hand-it-to-Claude flow, verbatim from the desktop's git.* locale keys
// (src/i18n/locales/en.js) so both clients say the same thing. One generic merge prompt
// covers all three cases; `operation` and the raw git error tell the agent what was
// being attempted and what went wrong, so it doesn't have to re-derive either.
const MERGE = {
  prompt: "Resolve this git/GitHub problem: pull and push the current branch, resolve any merge conflicts, run the tests, and make sure you don't break any feature.",
  promptOp: 'This came up while I was',
  promptError: 'The git error was:',
  opPull: 'pulling the current branch (git pull).',
  opPush: 'pushing the current branch (git push).',
  opResolve: 'resolving merge conflicts already in the working tree.',
  pullTitle: 'Pull needs a merge',
  pullMsg: "The local and remote branches have diverged, so a plain pull can't fast-forward. Start a Claude session to pull, merge, resolve any conflicts, and push?",
  pushTitle: 'Push was rejected',
  pushMsg: 'The remote has commits this branch does not, so the push was rejected. Start a Claude session to pull, merge, resolve any conflicts, and push?',
  conflictsTitle: 'Merge conflicts',
  conflictsMsg: 'This repository has unresolved merge conflicts. Start a Claude session to resolve them and finish the pull and push?',
  ok: 'Let Claude handle it',
};

// Pull and push differ only in their channel and their copy.
const SYNC = {
  pull: { label: 'Pull', channel: 'git-pull', title: MERGE.pullTitle, message: MERGE.pullMsg, operation: MERGE.opPull },
  push: { label: 'Push', channel: 'git-push', title: MERGE.pushTitle, message: MERGE.pushMsg, operation: MERGE.opPush },
} as const;

function mergePrompt(operation: string, errorText?: string) {
  const parts = [MERGE.prompt, `${MERGE.promptOp} ${operation}`];
  const err = (errorText || '').trim();
  if (err) parts.push(`${MERGE.promptError}\n${err}`);
  return parts.join('\n\n');
}

// The porcelain code a row carries, as a letter and a colour. `?` (untracked) reads as
// "U" the way it does in VS Code — a bare question mark next to a filename looks like a
// missing icon rather than a status. Anything unrecognised keeps its own letter in grey.
const STATUS: Record<string, { letter: string; color: string; name: string }> = {
  M: { letter: 'M', color: color.fileYellow, name: 'modified' },
  A: { letter: 'A', color: color.fileGreen, name: 'added' },
  D: { letter: 'D', color: color.fileRed, name: 'deleted' },
  R: { letter: 'R', color: color.accent, name: 'renamed' },
  C: { letter: 'C', color: color.accent, name: 'copied' },
  U: { letter: 'C', color: color.fileRed, name: 'conflicted' },
  '?': { letter: 'U', color: color.fileGreen, name: 'untracked' },
};

function statusMeta(code: string) {
  const key = (code || '').trim().charAt(0);
  return STATUS[key] ?? { letter: key || '·', color: color.muted, name: 'changed' };
}

// A section's hue says what its rows are: staged work is green (ready to go),
// unstaged is the same yellow a modified file carries, a conflict is red.
const SECTION_HUE: Record<string, string> = {
  staged: color.green,
  unstaged: color.fileYellow,
  conflicts: color.fileRed,
};

const sectionHue = (key: string) => SECTION_HUE[key] ?? color.muted;

// Split a repo-relative path into the filename and the folder above it, so a row can
// lead with the name (what you're looking for) and trail the path in muted text.
function splitPath(rel: string) {
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? { name: rel, dir: '' } : { name: rel.slice(cut + 1), dir: rel.slice(0, cut) };
}

// gh opens its pages in the *desktop's* browser — the phone user isn't looking at
// that screen, so the toast says where it went, and offers the link here too when
// gh printed one.
function desktopBrowserToast(message: string, reply?: Res) {
  const url = replyUrl(reply);
  showToast({
    message,
    tone: 'success',
    ...(url ? { actionLabel: 'Open here', onAction: () => { Linking.openURL(url).catch(() => {}); } } : {}),
  });
}

export default function GitScreen({ navigation }: any) {
  const { conn } = useConnection();
  const { project } = useContext(ChromeContext);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<'pull' | 'push' | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const menuDismiss = useAfterDismiss();
  // Bumped after anything that can move the log, so a mounted History reloads.
  const [historySignal, setHistorySignal] = useState(0);

  const refresh = useCallback(async (pulled = false) => {
    if (!conn || conn.state !== 'ready') return;
    if (pulled) setRefreshing(true);
    try {
      setStatus(await conn.req<Status>('git-status'));
      setLoadError('');
    } catch (e: any) {
      // Keep the last good status on screen; only a first load with nothing to show
      // falls to the error state. A reconnect refetches either way.
      setLoadError(String(e?.message ?? e));
    } finally {
      if (pulled) setRefreshing(false);
    }
  }, [conn]);

  // The tab navigator keeps this screen mounted, so a mount effect would run once
  // ever — refetch whenever the tab regains focus (the branch may have changed since).
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Refetch on reconnect and on a project switch, for parity with the Sessions screen.
  // Without the reconnect refetch, opening this tab while the socket is down leaves it
  // stuck on `—`: `refresh` early-returns on `state !== 'ready'` and nothing retries.
  useEffect(() => {
    if (!conn) return;
    const offState = conn.onState((s) => { if (s === 'ready') refresh(); });
    const offFolder = conn.on('folder-changed', () => { setStatus(null); refresh(); });
    return () => { offState(); offFolder(); };
  }, [conn, refresh]);

  const afterChange = () => {
    refresh();
    setHistorySignal((n) => n + 1);
  };

  // Every mutation funnels through here: it serializes on the busy flag, surfaces
  // git's stderr (git reports most failures as ok:false, not a throw), then refreshes.
  // `success`, when given, is the toast a clean run ends with.
  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      const r = (await fn()) as Res | undefined;
      if (r && r.ok === false) showError(label, r.stderr || `${label} failed`);
      else if (success) showToast({ message: success, tone: 'success' });
    } catch (e: any) {
      showError(label, e);
    }
    setBusy(false);
    afterChange();
  };

  // The message is optional: main's git-commit stages everything when nothing is
  // staged and authors the message with Haiku when it's empty — the same contract the
  // desktop pane relies on. So this stays enabled whenever the tree is dirty, and shows
  // "Writing…" while Haiku runs (an empty message means a round trip to the model).
  const dirty = !!(status?.staged.length || status?.unstaged.length);
  const [writing, setWriting] = useState(false);
  // Offer to hand a git problem to a fresh Claude session — the desktop's
  // offerClaudeMerge. Confirms first, then spawns the session, primes it with the
  // prompt, and opens its terminal so the user watches the agent work.
  const offerClaude = async (title: string, message: string, operation: string, errorText?: string) => {
    if (!(await confirmAction({ title, message, confirmLabel: MERGE.ok, destructive: false }))) return;
    try {
      const id = await newSessionWithPrompt(conn!, mergePrompt(operation, errorText));
      navigation.navigate('Chat', { id });
    } catch (e: any) {
      showError('Session', e);
    }
  };

  // Pull/push don't go through run(): each shows its own spinner, and a failure
  // that's fixable by a merge is handed to Claude rather than dumped as a wall of git
  // text. main flags exactly that case with `needsMerge` (a diverged branch /
  // rejected push); anything else is a plain error with git's stderr.
  const sync = async (kind: 'pull' | 'push') => {
    const cfg = SYNC[kind];
    setSyncing(kind);
    setBusy(true);
    try {
      const r = await conn!.req<Res>(cfg.channel);
      if (r && r.ok === false) {
        if (r.needsMerge) offerClaude(cfg.title, cfg.message, cfg.operation, r.stderr);
        else showError(cfg.label, r.stderr || `${cfg.label} failed`);
      } else {
        showToast({ message: syncSuccessMessage(kind, r), tone: 'success' });
      }
    } catch (e: any) {
      showError(cfg.label, e);
    }
    setSyncing(null);
    setBusy(false);
    afterChange();
  };

  const commit = () => {
    haptic.tap();
    setWriting(!msg.trim());
    run('Commit', async () => {
      try {
        const r = await conn!.req<Res>('git-commit', msg.trim());
        if (r?.ok) setMsg('');
        return r;
      } finally {
        setWriting(false);
      }
    }, 'Committed');
  };

  const stageToggle = (item: Entry, staged: boolean) => {
    haptic.tap();
    run(staged ? 'Unstage' : 'Stage', () => conn!.req(staged ? 'git-unstage' : 'git-stage', item.file));
  };

  const revert = async (item: Entry) => {
    const ok = await confirmAction({
      title: 'Discard changes',
      message: `Discard all changes to ${item.file}? This cannot be undone.`,
      confirmLabel: 'Discard',
    });
    if (ok) {
      run('Discard', () => conn!.req('git-revert', { file: item.file, untracked: item.status === '?' }),
        `Discarded ${splitPath(item.file).name}`);
    }
  };

  // Discard every unstaged change at once — the desktop's "Changes" header button.
  // Staged files are deliberately left alone, same as the desktop.
  const revertAll = async () => {
    const files = status?.unstaged ?? [];
    if (!files.length) return;
    const ok = await confirmAction({
      title: 'Discard all changes',
      message: `Discard changes to all ${files.length} file${files.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Discard all',
    });
    if (!ok) return;
    run('Discard all', async () => {
      for (const f of files) {
        const r = await conn!.req<Res>('git-revert', { file: f.file, untracked: f.status === '?' });
        if (r && r.ok === false) return r;
      }
      return undefined;
    }, 'Changes discarded');
  };

  // git-stage takes the whole list in one request (main chunks it), as the desktop does.
  const stageAll = () => {
    const files = (status?.unstaged ?? []).map((f) => f.file);
    if (!files.length) return;
    haptic.tap();
    run('Stage all', () => conn!.req('git-stage', files));
  };

  // --- the ⋯ menu: everything that doesn't earn a permanent button, as on the desktop.
  const fetchRemote = () => run('Fetch', () => conn!.req('git-fetch'), 'Fetched');

  // A message typed in the commit box replaces the old one; an empty box keeps it.
  const amend = () => {
    const text = msg.trim();
    run('Amend', async () => {
      const r = await conn!.req<Res>('git-amend', text);
      if (r?.ok && text) setMsg('');
      return r;
    }, 'Last commit amended');
  };

  const undoLast = () => run('Undo', () => conn!.req('git-undo'), 'Last commit undone — its changes are staged');

  const forcePush = async () => {
    const ok = await confirmAction({
      title: 'Force push this branch?',
      message: 'This overwrites the remote branch with your local one. It is refused if someone else has pushed since your last fetch, but commits only you have will be lost.',
      confirmLabel: 'Force push',
    });
    if (ok) run('Force push', () => conn!.req('git-force-push'), 'Force pushed');
  };

  const cleanUntracked = async () => {
    const ok = await confirmAction({
      title: 'Delete untracked files?',
      message: "Every file and folder git isn't tracking will be deleted from this repository. Ignored files are kept. This can't be undone.",
      confirmLabel: 'Delete',
    });
    if (ok) run('Delete untracked files', () => conn!.req('git-clean-untracked'), 'Untracked files deleted');
  };

  // The gh hand-offs. main pushes the branch before creating a PR, so this can take a
  // while — it holds the busy flag like any other mutation.
  const createPr = async () => {
    setBusy(true);
    showToast({ message: 'Creating pull request…', tone: 'info' });
    try {
      const r = await conn!.req<Res>('gh-pr-create');
      if (r && r.ok === false) showError('Create pull request', r.stderr || 'Could not create the pull request');
      else desktopBrowserToast(prCreateMessage(r), r);
    } catch (e: any) {
      showError('Create pull request', e);
    }
    setBusy(false);
    afterChange();
  };

  const openOnGitHub = async (label: string, channel: string, fallback: string) => {
    try {
      const r = await conn!.req<Res>(channel);
      if (r && r.ok === false) showError(label, r.stderr || fallback);
      else desktopBrowserToast('Opened in the desktop browser', r);
    } catch (e: any) {
      showError(label, e);
    }
  };

  const typedMessage = msg.trim();
  const menuActions: SheetAction[] = [
    { key: 'fetch', label: 'Fetch', icon: 'cloud-download-outline', hint: 'Check the remote for new commits', onPress: fetchRemote },
    { key: 'stash', label: 'Stashes…', icon: 'archive-outline', hint: 'Set changes aside, or bring them back', onPress: () => menuDismiss.schedule(() => setStashOpen(true)) },
    {
      key: 'amend', label: 'Amend last commit', icon: 'create-outline',
      hint: typedMessage ? `Folds in your changes, with the message “${typedMessage}”` : 'Folds in your changes and keeps its message',
      onPress: amend,
    },
    { key: 'undo', label: 'Undo last commit', icon: 'arrow-undo-outline', hint: 'Its changes stay staged', onPress: undoLast },
    { key: 'pr-create', label: 'Create pull request', icon: 'git-pull-request-outline', hint: 'Pushes the branch first', onPress: createPr },
    {
      key: 'pr-view', label: 'Open pull request', icon: 'open-outline', hint: 'Opens in the desktop browser',
      onPress: () => openOnGitHub('Open pull request', 'gh-pr-view', 'No pull request for this branch'),
    },
    {
      key: 'browse', label: 'Open repository on GitHub', icon: 'logo-github', hint: 'Opens in the desktop browser',
      onPress: () => openOnGitHub('Open on GitHub', 'gh-browse', 'Could not open the repository'),
    },
    { key: 'force-push', label: 'Force push (with lease)', icon: 'warning-outline', destructive: true, onPress: forcePush },
    { key: 'clean', label: 'Delete untracked files', icon: 'trash-outline', destructive: true, onPress: cleanUntracked },
  ].map((a) => ({
    ...a,
    disabled: busy,
    // Close first, then act — see the header comment.
    onPress: () => { setMenuOpen(false); a.onPress(); },
  }));

  // Empty sections are dropped rather than shown with a "(0)": on a phone a clean tree
  // should read as one calm empty state, not as two headers with nothing under them.
  const sections = (status?.ok ? [
    { key: 'conflicts', title: 'Conflicts', data: status.conflicts, staged: false, conflict: true },
    { key: 'staged', title: 'Staged', data: status.staged, staged: true, conflict: false },
    { key: 'unstaged', title: 'Changes', data: status.unstaged, staged: false, conflict: false },
  ] : []).filter((s) => s.data.length > 0);

  if (!project) {
    return (
      <View style={styles.fill}>
        <ScreenHeader title="Git" />
        <NoProject />
      </View>
    );
  }

  // Before the first answer, the Changes body must not claim the tree is clean.
  const changesState = !status
    ? (loadError ? 'error' : 'loading')
    : !status.ok ? 'repo-error' : 'ready';

  return (
    <View style={styles.fill}>
      {/* Titled like every other tab. The branch chip below names the branch, not the
          screen, so it isn't a substitute — and a frame that's a heading everywhere
          else and a bare toolbar here reads as the one screen that lost its title.
          The controls stay on the page rather than in the frame: they're styled to
          read as raised against it (see `branchBtn`). */}
      <ScreenHeader title="Git" />

      <View style={styles.controls}>
        {/* The branch / pull / push / ⋯ row stays put across both views — it's about
            the branch, not about what you're looking at. Only the body and the commit
            bar swap. */}
        <View style={styles.branchBar}>
          <Pressable
            style={({ pressed }) => [styles.branchBtn, pressed && styles.pressed]}
            onPress={() => setBranchOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Branch ${status?.branch || 'unknown'}. Switch branch`}
          >
            <Ionicons name="git-branch-outline" size={15} color={color.accent} />
            <Text style={styles.branchName} numberOfLines={1}>{status?.branch || '—'}</Text>
            <Ionicons name="chevron-down" size={13} color={color.muted} />
          </Pressable>

          {/* The badge is a sibling of the button, not a child: Android clips children
              that overflow a parent with a border radius, which would crop the circle. */}
          {(['pull', 'push'] as const).map((kind) => {
            const running = syncing === kind;
            const count = kind === 'pull' ? status?.behind : status?.ahead;
            return (
              <View key={kind} style={styles.actionWrap}>
                <Pressable
                  style={({ pressed }) => [styles.action, pressed && styles.pressed, busy && !running && styles.actionOff]}
                  disabled={busy}
                  onPress={() => sync(kind)}
                  accessibilityRole="button"
                  accessibilityLabel={`${SYNC[kind].label}${count ? `, ${count} commit${count === 1 ? '' : 's'}` : ''}`}
                  accessibilityState={{ disabled: busy, busy: running }}
                >
                  {running
                    ? <ActivityIndicator size="small" color={color.text} style={styles.actionSpinner} />
                    : <Ionicons name={kind === 'pull' ? 'arrow-down-outline' : 'arrow-up-outline'} size={15} color={busy ? color.faint : color.text} />}
                  <Text style={[styles.actionLabel, busy && !running && styles.actionLabelOff]}>{SYNC[kind].label}</Text>
                </Pressable>
                <CountBadge n={count} />
              </View>
            );
          })}

          <Pressable
            style={({ pressed }) => [styles.action, styles.moreBtn, pressed && styles.pressed]}
            onPress={() => { haptic.tap(); setMenuOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel="More git actions"
          >
            <Ionicons name="ellipsis-horizontal" size={17} color={color.text} />
          </Pressable>
        </View>

        <View style={styles.segments} accessibilityRole="tablist">
          {(['changes', 'history'] as const).map((k) => (
            <Pressable
              key={k}
              style={[styles.segment, tab === k && styles.segmentOn]}
              onPress={() => { if (tab !== k) haptic.tap(); setTab(k); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === k }}
            >
              <Text style={[styles.segmentLabel, tab === k && styles.segmentLabelOn]}>
                {k === 'changes' ? 'Changes' : 'History'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {tab === 'history' && <CommitHistory onChanged={refresh} reloadSignal={historySignal} />}

      {tab === 'changes' && changesState === 'loading' && <LoadingState label="Reading git status…" />}
      {tab === 'changes' && changesState === 'error' && (
        <ErrorState title="Couldn't read git status" message={loadError} onRetry={() => refresh()} />
      )}
      {tab === 'changes' && changesState === 'repo-error' && (
        <ErrorState title="Git isn't available here" message={status?.error} onRetry={() => refresh()} />
      )}

      {/* iOS doesn't move content for the keyboard on its own, so the floating commit
          bar would sit under it. The view starts at the screen's top (the tab has no
          navigator header), so its frame is already in window coordinates and needs
          no vertical offset. Android's adjustResize handles it natively. */}
      {tab === 'changes' && changesState === 'ready' && (
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <SectionList
            sections={sections}
            keyExtractor={(e, i) => e.file + i}
            refreshing={refreshing}
            onRefresh={() => refresh(true)}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={sections.length ? styles.listPad : styles.grow}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }: any) => (
              <View style={styles.section}>
                <CategoryLabel label={section.title} hue={sectionHue(section.key)} count={section.data.length} />
                <View style={styles.spacer} />
                {/* The desktop's "Let Claude resolve" button: conflicts already in the
                    working tree are a merge problem the agent can finish. */}
                {section.key === 'conflicts' && (
                  <Pressable
                    style={({ pressed }) => [styles.resolve, pressed && styles.resolvePressed]}
                    hitSlop={8}
                    onPress={() => offerClaude(MERGE.conflictsTitle, MERGE.conflictsMsg, MERGE.opResolve)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="sparkles-outline" size={13} color={color.accent} />
                    <Text style={styles.resolveLabel}>Let Claude resolve</Text>
                  </Pressable>
                )}
                {/* Discard then stage — the same order (and icons) as the file rows below,
                    so the "all" actions sit in the same columns as their per-file twins. */}
                {section.key === 'unstaged' && (
                  <>
                    <Pressable
                      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                      disabled={busy}
                      hitSlop={4}
                      onPress={revertAll}
                      accessibilityRole="button"
                      accessibilityLabel="Discard all changes"
                      accessibilityState={{ disabled: busy }}
                    >
                      <Ionicons name="arrow-undo-outline" size={16} color={color.fileRed} />
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                      disabled={busy}
                      hitSlop={4}
                      onPress={stageAll}
                      accessibilityRole="button"
                      accessibilityLabel="Stage all changes"
                      accessibilityState={{ disabled: busy }}
                    >
                      <Ionicons name="add" size={18} color={color.fileGreen} />
                    </Pressable>
                  </>
                )}
              </View>
            )}
            // A section's rows are one card. SectionList renders them as siblings, so the
            // card is assembled from the edges: the first row draws the top, the last the
            // bottom, and the ones between carry only the sides.
            renderItem={({ item, section, index }: any) => (
              <View
                style={[
                  styles.card,
                  index === 0 && styles.cardFirst,
                  index === section.data.length - 1 && styles.cardLast,
                ]}
              >
                {index > 0 && <Divider inset={46} />}
                <FileRow
                  item={item}
                  busy={busy}
                  staged={section.staged}
                  conflict={section.conflict}
                  onOpen={() => setFileTarget({ entry: item, staged: section.staged, conflict: section.conflict })}
                  onRevert={() => revert(item)}
                  onToggle={() => stageToggle(item, section.staged)}
                />
              </View>
            )}
            ListEmptyComponent={
              <EmptyState icon="checkmark-done-outline" title="Working tree clean" message="Nothing to commit." />
            }
          />

          <View style={styles.commitBar}>
            <TextInput
              style={styles.input}
              placeholder="Message — Claude writes one"
              placeholderTextColor={color.faint}
              value={msg}
              onChangeText={setMsg}
              accessibilityLabel="Commit message"
            />
            <Pressable
              style={({ pressed }) => [
                styles.commit, pressed && styles.commitPressed,
                (busy || !dirty) && styles.commitOff,
              ]}
              disabled={busy || !dirty}
              onPress={commit}
              accessibilityRole="button"
              accessibilityLabel={writing ? 'Writing commit message' : 'Commit'}
              accessibilityState={{ disabled: busy || !dirty, busy: writing }}
            >
              {writing
                ? <ActivityIndicator size="small" color={color.muted} />
                : <Text style={[styles.commitLabel, !dirty && styles.commitLabelOff]}>Commit</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      <FileDiffSheet
        target={fileTarget}
        busy={busy}
        onClose={() => setFileTarget(null)}
        onStale={() => refresh()}
        onRevert={(e) => { setFileTarget(null); revert(e); }}
        onToggle={(e, staged) => { setFileTarget(null); stageToggle(e, staged); }}
      />

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onDismiss={menuDismiss.onDismiss}
        title="Git"
        subtitle={status?.branch}
      >
        <ActionList actions={menuActions} />
      </Sheet>

      <StashSheet open={stashOpen} onClose={() => setStashOpen(false)} onChanged={afterChange} />

      <BranchSheet
        open={branchOpen}
        current={status?.branch || ''}
        onClose={() => setBranchOpen(false)}
        onPick={(b) => run('Switch branch', () => conn!.req('git-checkout', checkoutName(b)), `Switched to ${checkoutName(b)}`)}
        onCreate={(name) => run('Create branch', () => conn!.req('git-create-branch', name), `Created ${name}`)}
        onDelete={(name) => run('Delete branch', () => conn!.req('git-delete-branch', name), `Deleted ${name}`)}
      />
    </View>
  );
}

// One changed file. Laid out like a Files-tab row (icon, name, muted folder beneath) so
// the two lists read as the same app, with the porcelain code as a tinted letter chip and
// the actions as full-size tap targets rather than the bare glyphs they used to be.
// Tapping the row itself opens its diff.
function FileRow({ item, busy, staged, conflict, onOpen, onRevert, onToggle }: {
  item: Entry;
  busy: boolean;
  staged: boolean;
  conflict: boolean;
  onOpen: () => void;
  onRevert: () => void;
  onToggle: () => void;
}) {
  const { name, dir } = splitPath(item.file);
  const st = statusMeta(item.status);
  const deleted = st.letter === 'D';
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${item.file}, ${st.name}${staged ? ', staged' : ''}`}
      accessibilityHint="Shows the file's diff"
    >
      {/* A deleted file's icon would advertise a file that isn't there any more. */}
      <View style={[styles.rowIcon, deleted && styles.iconGone]}>
        <FileIcon name={name} size={17} />
      </View>

      <View style={styles.rowMain}>
        <Text style={[styles.file, deleted && styles.fileDeleted]} numberOfLines={1}>{name}</Text>
        {!!dir && <Text style={styles.dir} numberOfLines={1}>{dir}</Text>}
      </View>

      <View style={styles.stat}>
        <StatusBadge letter={st.letter} hue={st.color} />
      </View>

      {/* Conflicted files can't be staged or discarded piecemeal — resolving one
          is a deliberate edit, so they carry no actions (as on the desktop). */}
      {!conflict && (
        <>
          {!staged && (
            <Pressable
              style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
              disabled={busy}
              hitSlop={4}
              onPress={onRevert}
              accessibilityRole="button"
              accessibilityLabel={`Discard changes to ${name}`}
              accessibilityState={{ disabled: busy }}
            >
              <Ionicons name="arrow-undo-outline" size={16} color={color.fileRed} />
            </Pressable>
          )}
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
            disabled={busy}
            hitSlop={4}
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={`${staged ? 'Unstage' : 'Stage'} ${name}`}
            accessibilityState={{ disabled: busy }}
          >
            <Ionicons
              name={staged ? 'remove' : 'add'}
              size={18}
              color={staged ? color.fileYellow : color.fileGreen}
            />
          </Pressable>
        </>
      )}
    </Pressable>
  );
}

// A changed file's diff, fetched when its row is tapped, with the row's own actions
// pinned under it. main re-checks the path at fetch time (another session may have
// committed it since the list was drawn) and answers `clean: true` when there's
// nothing left — the list was stale, so it's refetched.
function FileDiffSheet({ target, busy, onClose, onStale, onRevert, onToggle }: {
  target: FileTarget | null;
  busy: boolean;
  onClose: () => void;
  onStale: () => void;
  onRevert: (e: Entry) => void;
  onToggle: (e: Entry, staged: boolean) => void;
}) {
  const { conn } = useConnection();
  const [patch, setPatch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Keep drawing the last file while the sheet slides away.
  const last = useRef<FileTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;

  useEffect(() => {
    if (!target || !conn) return;
    let cancelled = false;
    setPatch('');
    setError('');
    setStale(false);
    setLoading(true);
    const { entry, staged } = target;
    conn.req<Res>('git-diff', { file: entry.file, staged, untracked: entry.status === '?' })
      .then((r) => {
        if (cancelled) return;
        // An untracked file is diffed with `--no-index`, which exits 1 when the sides
        // differ — so a patch on stdout wins over ok:false.
        if (r?.stdout) setPatch(r.stdout);
        else if (r?.clean) { setStale(true); onStale(); }
        else if (r?.ok === false) setError(r.stderr || 'Could not load the diff.');
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // onStale is deliberately not a dependency: it's a fresh closure every render,
    // and refetching on it would loop.
  }, [target, conn, attempt]);

  const actions: DiffSheetAction[] = [];
  if (shown && !stale) {
    const { entry, staged, conflict } = shown;
    if (conflict) {
      actions.push({ label: 'Mark resolved', icon: 'checkmark', onPress: () => onToggle(entry, false), disabled: busy });
    } else if (staged) {
      actions.push({ label: 'Unstage', icon: 'remove', tone: 'secondary', onPress: () => onToggle(entry, true), disabled: busy });
    } else {
      actions.push(
        { label: 'Discard', icon: 'arrow-undo-outline', tone: 'danger', onPress: () => onRevert(entry), disabled: busy },
        { label: 'Stage', icon: 'add', onPress: () => onToggle(entry, false), disabled: busy },
      );
    }
  }

  const name = shown ? splitPath(shown.entry.file) : { name: '', dir: '' };
  return (
    <DiffSheet
      open={!!target}
      title={name.name}
      subtitle={[name.dir, shown ? (shown.staged ? 'Staged' : shown.conflict ? 'Conflicted' : 'Unstaged') : '']
        .filter(Boolean).join(' · ')}
      patch={patch}
      loading={loading}
      error={error}
      emptyLabel={stale ? 'No longer changed — the list was out of date.' : 'No changes'}
      actions={actions}
      onClose={onClose}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

// Commit count on the push/pull buttons: a green circle pinned to the top-right
// corner, mirroring the desktop's .git-ahead-badge / .git-behind-badge. The ring is
// the button-row background colour, so the circle reads as sitting *on* the corner
// rather than inside the button. Hidden at zero (nothing to push / pull).
function CountBadge({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <View style={styles.badge} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Text style={styles.badgeText}>{n}</Text>
    </View>
  );
}

// Branch picker. Fetched fresh each time it opens so branches created elsewhere show
// up. The search box doubles as the create field: a name matching no existing branch
// reveals a "Create" row that branches off the current HEAD — same as the desktop.
function BranchSheet({ open, current, onClose, onPick, onCreate, onDelete }: {
  open: boolean;
  current: string;
  onClose: () => void;
  onPick: (b: Branch) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const { conn } = useConnection();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !conn) return;
    setQuery('');
    setLoading(true);
    conn.req<{ ok: boolean; branches: Branch[] }>('git-branches')
      .then((r) => setBranches(r?.branches ?? []))
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
  }, [open, conn]);

  const q = query.trim().toLowerCase();
  const matches = branches.filter((b) => b.name.toLowerCase().includes(q));
  const newName = normalizeBranchName(query);
  const canCreate = !!newName && !branches.some((b) => b.name === newName);

  // Close first, then act: the action's toast or error must not land behind the sheet.
  const act = (fn: () => void) => { onClose(); fn(); };

  const confirmDelete = async (name: string) => {
    const ok = await confirmAction({
      title: 'Delete branch',
      message: `Delete branch “${name}”? This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (ok) act(() => onDelete(name));
  };

  return (
    <Sheet open={open} onClose={onClose} title="Branches">
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          placeholder="Search or type a new branch name"
          placeholderTextColor={color.faint}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search branches, or type a new branch name"
        />
        {!!query && (
          <IconButton icon="close-circle" label="Clear search" size={16} hue={color.faint} onPress={() => setQuery('')} />
        )}
      </View>

      {loading
        ? <ActivityIndicator style={styles.loading} color={color.accent} />
        : (
          <FlatList
            data={matches}
            keyExtractor={(b) => b.name}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={canCreate ? (
              <Pressable
                style={({ pressed }) => [styles.branchRow, pressed && styles.pressed]}
                onPress={() => act(() => onCreate(newName))}
                accessibilityRole="button"
              >
                <Ionicons name="add-circle-outline" size={16} color={color.fileGreen} />
                <Text style={styles.createLabel} numberOfLines={1}>Create “{newName}”</Text>
              </Pressable>
            ) : null}
            ListEmptyComponent={canCreate ? null : <Text style={styles.sheetEmpty}>No branches match.</Text>}
            renderItem={({ item }) => {
              const isCurrent = item.name === current;
              return (
                <Pressable
                  style={({ pressed }) => [styles.branchRow, pressed && styles.pressed]}
                  onPress={() => (isCurrent ? onClose() : act(() => onPick(item)))}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}${item.remote ? ', remote' : ''}${isCurrent ? ', current branch' : ''}`}
                  accessibilityState={{ selected: isCurrent }}
                >
                  <Ionicons
                    name={isCurrent ? 'checkmark' : item.remote ? 'cloud-outline' : 'git-branch-outline'}
                    size={16}
                    color={isCurrent ? color.fileGreen : color.muted}
                  />
                  <Text style={[styles.branchLabel, isCurrent && styles.branchLabelOn]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {/* Git refuses to delete the checked-out branch, and a remote-tracking
                      branch isn't ours to delete locally — so only other locals get a trash. */}
                  {!isCurrent && !item.remote && (
                    <Pressable
                      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                      hitSlop={4}
                      onPress={() => confirmDelete(item.name)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete branch ${item.name}`}
                    >
                      <Ionicons name="trash-outline" size={15} color={color.fileRed} />
                    </Pressable>
                  )}
                </Pressable>
              );
            }}
          />
        )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // The page colour is spelled out because the navigator's DarkTheme would otherwise
  // show through — its background is rgb(1,1,1), a black that belongs to no token and
  // reads as a hole next to #0d1117.
  fill: { flex: 1, backgroundColor: color.bg },
  pressed: { backgroundColor: color.raised },

  // The branch row and the switch live on the page, not in the header frame — the
  // frame carries the toolbar and nothing else. That flips their surfaces: recessed
  // `bg` fills read as wells against the header's gradient, but they'd vanish into
  // the page, so on the page they're `surface` and read as raised instead.
  // The bottom pad is the switch's own breathing room, and it has to live here rather
  // than on either body: the Changes list brings its own top padding but History's
  // commit rows start flush, so a gap left to the body would exist on one tab only.
  // 12 is the mock's own `margin-bottom` on the segmented control.
  controls: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  branchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 12 },
  branchBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
  branchName: { flex: 1, color: color.text, fontSize: 14, fontWeight: '600' },

  actionWrap: { position: 'relative' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
  // The spinner swaps in for the 15px arrow; pinning its box keeps the label still.
  actionSpinner: { width: 15, height: 15, transform: [{ scale: 0.75 }] },
  moreBtn: { width: 44, paddingHorizontal: 0, justifyContent: 'center' },
  actionOff: { opacity: 0.5 },
  actionLabel: { color: color.text, fontSize: 13, fontWeight: '600' },
  actionLabelOff: { color: color.faint },
  badge: {
    position: 'absolute', top: -7, right: -7, zIndex: 2,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.greenDeep,
    // The desktop draws this ring with a box-shadow spread; RN has no spread, so a
    // border in the surrounding colour gives the same detached-from-the-button look.
    // The surround is the page now that the row sits below the header.
    borderWidth: 2, borderColor: color.bg,
  },
  badgeText: {
    color: '#fff', fontSize: 10, fontWeight: '700',
    fontVariant: ['tabular-nums'], includeFontPadding: false,
  },

  segments: {
    flexDirection: 'row', backgroundColor: color.surface, borderRadius: radius.md, padding: 2,
  },
  // Concentric with the track: its radius less the track's 2px padding.
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 36, borderRadius: radius.md - 2 },
  segmentOn: { backgroundColor: color.raisedHi, ...shadow.thumb },
  segmentLabel: { color: color.muted, fontSize: 13, fontWeight: '600' },
  segmentLabelOn: { color: color.text },

  grow: { flexGrow: 1 },
  // No top pad: every section header already carries its own (`section.paddingTop`),
  // and one here stacked on top of that — the first title sat under twice the gap of
  // the ones below it, which read as the list hanging off the switch.
  //
  // The bottom pad is the floating commit bar's height (42 + 10 either side) plus a
  // gap, so the last changed file scrolls clear of it instead of under it forever.
  listPad: { paddingHorizontal: 16, paddingBottom: 70 },

  section: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 14, paddingBottom: 8,
  },
  spacer: { flex: 1 },

  // The three pieces a section's card is assembled from — see renderItem.
  card: { backgroundColor: color.surface, borderLeftWidth: 1, borderRightWidth: 1, borderColor: color.borderSoft },
  cardFirst: { borderTopWidth: 1, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card },
  cardLast: { borderBottomWidth: 1, borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    minHeight: 52, paddingLeft: 14, paddingRight: 6, paddingVertical: 4,
  },
  rowIcon: { width: 17, marginRight: 8, alignItems: 'center' },
  iconGone: { opacity: 0.45 },
  rowMain: { flex: 1, minWidth: 0 },
  file: { color: color.body, fontSize: font.size.md },
  fileDeleted: { color: color.muted, textDecorationLine: 'line-through' },
  dir: { color: color.faint, fontSize: 11, marginTop: 2 },

  stat: { marginRight: 2 },

  resolve: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill,
    backgroundColor: tint.fill(color.accent),
    borderWidth: StyleSheet.hairlineWidth, borderColor: tint.line(color.accent),
  },
  resolvePressed: { backgroundColor: tint.flash(color.accent) },
  resolveLabel: { color: color.accent, fontSize: 12, fontWeight: '600' },

  // 36 visual + a 4pt hitSlop each side = a 44pt touch target.
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  iconBtnPressed: { backgroundColor: color.raised },

  // Floated over the list rather than docked under it, and with no fill of its own:
  // the changes are what the screen is about, and a solid strip across the bottom
  // hid a row's worth of them behind something that is only occasionally used. The
  // list's paddingBottom keeps the last row reachable above it.
  commitBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10,
  },
  // Half-transparent black, not opaque and not clear: the changes still read through
  // the field (which is the point of floating it over them), but typed text sits on
  // something dark enough to stay legible over a row rather than on the row itself.
  // `#0008` is the same black-at-alpha idiom as the sheets' scrim.
  //
  // A real frosted blur would be better here and isn't reachable: it needs `expo-blur`,
  // which is a native module — a new dependency and a rebuild of every dev client — so
  // this is the flat approximation of it.
  input: {
    flex: 1, height: 44, color: color.text,
    backgroundColor: '#0008',
    borderWidth: 1, borderColor: color.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 0, fontSize: 14,
  },
  commit: {
    minWidth: 84, height: 44, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, borderRadius: radius.md, backgroundColor: color.greenDeep,
  },
  // Same pressed treatment as the shared Button primitive.
  commitPressed: { opacity: 0.85 },
  commitOff: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  commitLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  commitLabelOff: { color: color.muted },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginHorizontal: 12, marginTop: 10, marginBottom: 8, paddingLeft: 10, paddingRight: 2,
    minHeight: 44, borderRadius: radius.md, backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
  },
  search: { flex: 1, color: color.text, fontSize: 14, paddingVertical: 8 },
  loading: { marginVertical: 24 },
  sheetEmpty: { color: color.muted, textAlign: 'center', marginTop: 32, marginBottom: 32 },
  branchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft,
  },
  branchLabel: { flex: 1, color: color.text, fontSize: 14 },
  branchLabelOn: { color: color.fileGreen, fontWeight: '600' },
  createLabel: { flex: 1, color: color.fileGreen, fontSize: 14, fontWeight: '600' },
});
