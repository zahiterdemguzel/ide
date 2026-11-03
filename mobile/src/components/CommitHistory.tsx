// Commit history for the Git tab: browse, search, view a commit's diff, and act on a
// commit. Mirrors the desktop History tab (src/renderer/git-pane.js) — its row
// action and its commit context menu — and main's git-log / git-commit-diff /
// git-undo-commit / git-revert-commit / git-branch-at / git-tag / git-cherry-pick /
// git-reset-to / gh-browse-commit channels.
//
// A commit's state decides its quick action, exactly as on the desktop:
//   • incoming — on the upstream, not local yet; a pull brings it in. No quick action
//                (its menu offers cherry-pick).
//   • unpushed — local only, so history can be safely rewritten: UNDO drops it.
//   • pushed   — on the remote; rewriting would diverge, so REVERT lands a new
//                commit that undoes it.
// Both confirm first, as the desktop's menu does: undo can excise an older commit by
// rebasing everything after it, and revert writes a commit everyone will see.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, ActivityIndicator, Linking, StyleSheet,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import {
  commitActionKeys, normalizeBranchName, quickCommitAction, replyUrl,
} from '../lib/git-actions';
import DiffSheet from './DiffSheet';
import { showError } from './ErrorDialog';
import { confirmAction, haptic, showToast } from './feedback';
import { ActionList, PromptForm, Sheet, useAfterDismiss, type SheetAction } from './GitSheets';
import { EmptyState, ErrorState, IconButton, LoadingState } from './ui';
import { color } from '../theme';

export type Commit = {
  hash: string; short: string; subject: string; author: string; relDate: string;
  pushed?: boolean; incoming?: boolean;
};
type LogRes = { ok: boolean; error?: string; commits: Commit[]; incoming: Commit[]; hasMore: boolean };
type Res = { ok: boolean; stdout?: string; stderr?: string };

// Commits per request. Small enough that the first screen paints immediately on a
// phone, large enough that a scroll rarely waits on the next page.
const PAGE = 30;

const meta = (c: Commit) => `${c.short} · ${c.author} · ${c.relDate}`;

export default function CommitHistory({ onChanged, reloadSignal }: {
  onChanged: () => void;
  // Bumped by the parent after an action elsewhere (the ⋯ menu's amend/undo, a
  // pull) changed the log, so the list reloads without being remounted.
  reloadSignal?: number;
}) {
  const { conn } = useConnection();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [incoming, setIncoming] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [diff, setDiff] = useState<Commit | null>(null);
  const [menuFor, setMenuFor] = useState<Commit | null>(null);

  // Typing shouldn't fire a git log per keystroke; search only after a pause.
  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // Every load is stamped: a slower reply from a superseded query (or an earlier
  // page) must not overwrite the newer one, so stale responses are dropped.
  const gen = useRef(0);
  const load = useCallback(async (skip: number, pulled = false) => {
    if (!conn || conn.state !== 'ready') return;
    const mine = ++gen.current;
    setLoading(true);
    if (pulled) setRefreshing(true);
    try {
      const r = await conn.req<LogRes>('git-log', { limit: PAGE, skip, query: search });
      if (mine !== gen.current) return;
      setError(r?.ok === false ? (r.error || 'git log failed') : '');
      setCommits((prev) => (skip === 0 ? (r?.commits ?? []) : [...prev, ...(r?.commits ?? [])]));
      if (skip === 0) setIncoming(r?.incoming ?? []);
      setHasMore(!!r?.hasMore);
    } catch (e: any) {
      if (mine === gen.current) setError(String(e?.message ?? e));
    } finally {
      if (mine === gen.current) { setLoading(false); setRefreshing(false); }
    }
  }, [conn, search]);

  // Reload from the top whenever the query settles (and once on mount), and when
  // the parent signals the log moved.
  useEffect(() => { load(0); }, [load, reloadSignal]);

  // Paging key: skip by what we already hold. With a query, main pages the *matches*,
  // so this stays correct — commits.length is the number of matches already shown.
  const loadMore = () => { if (hasMore && !loading) load(commits.length); };

  // A rewrite/revert changes both the log and the working tree (undo leaves the
  // commit's changes staged), so refresh the history and tell the parent to refetch
  // git-status. Failures surface git's stderr — main reports them as ok:false, and a
  // conflicting rebase/cherry-pick is aborted there, so the tree is left clean.
  const act = async (label: string, success: string, fn: () => Promise<Res | undefined>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && r.ok === false) showError(label, r.stderr || `${label} failed`);
      else showToast({ message: success, tone: 'success' });
    } catch (e: any) {
      showError(label, e);
    }
    setBusy(false);
    load(0);
    onChanged();
  };

  const undo = async (c: Commit) => {
    const ok = await confirmAction({
      title: 'Undo this commit?',
      message: `“${c.subject}” is dropped from history. It isn't pushed yet, so nothing on the remote changes.`,
      confirmLabel: 'Undo commit',
    });
    if (ok) act('Undo commit', `Undid ${c.short}`, () => conn!.req<Res>('git-undo-commit', c.hash));
  };

  const revert = async (c: Commit) => {
    const ok = await confirmAction({
      title: 'Revert this commit?',
      message: `A new commit undoing “${c.subject}” is added on top. History is not rewritten, so this is safe for pushed commits.`,
      confirmLabel: 'Revert',
    });
    if (ok) act('Revert commit', `Reverted ${c.short}`, () => conn!.req<Res>('git-revert-commit', c.hash));
  };

  const resetTo = async (c: Commit, mode: 'soft' | 'hard') => {
    const hard = mode === 'hard';
    const ok = await confirmAction({
      title: hard ? 'Hard-reset the branch to this commit?' : 'Reset the branch to this commit?',
      message: hard
        ? "Every commit after this one — and every change in your working tree — is deleted. This can't be undone."
        : 'Every commit after this one is dropped, but all their changes stay staged so you can re-commit them.',
      confirmLabel: hard ? 'Hard reset' : 'Reset',
    });
    if (ok) act('Reset', `Branch reset to ${c.short}`, () => conn!.req<Res>('git-reset-to', { hash: c.hash, mode }));
  };

  // gh opens the commit in the *desktop's* browser. The phone can't know the URL
  // unless gh printed it, so the toast offers it here only when it did.
  const browse = async (c: Commit) => {
    try {
      const r = await conn!.req<Res>('gh-browse-commit', c.hash);
      if (r && r.ok === false) { showError('Open on GitHub', r.stderr || 'Could not open the commit'); return; }
      const url = replyUrl(r);
      showToast({
        message: 'Opened in the desktop browser',
        tone: 'info',
        ...(url ? { actionLabel: 'Open here', onAction: () => { Linking.openURL(url).catch(() => {}); } } : {}),
      });
    } catch (e: any) {
      showError('Open on GitHub', e);
    }
  };

  // Incoming commits sit above the local log, as on the desktop: they're a preview of
  // what the next pull brings in. They only come back on an unfiltered first page.
  const data = [...incoming, ...commits];
  const initialLoad = loading && !refreshing && data.length === 0;

  return (
    <View style={styles.fill}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={15} color={color.faint} />
        <TextInput
          style={styles.search}
          placeholder="Search message, author, or hash"
          placeholderTextColor={color.faint}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search commits"
        />
        {!!query && (
          <IconButton icon="close-circle" label="Clear search" size={16} hue={color.faint} onPress={() => setQuery('')} />
        )}
      </View>

      {/* A failed *later* page keeps what's already listed and says so above it; a
          failure with nothing listed is the list's error state below instead. */}
      {!!error && data.length > 0 && <Text style={styles.error} numberOfLines={3}>{error}</Text>}

      <FlatList
        data={data}
        keyExtractor={(c) => c.hash}
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing}
        onRefresh={() => load(0, true)}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={data.length ? undefined : styles.grow}
        renderItem={({ item }) => (
          <CommitRow
            c={item}
            busy={busy}
            onPress={() => setDiff(item)}
            onMenu={() => { haptic.tap(); setMenuFor(item); }}
            onQuick={() => (quickCommitAction(item) === 'undo' ? undo(item) : revert(item))}
          />
        )}
        ListFooterComponent={
          loading && !refreshing && data.length > 0
            ? <ActivityIndicator style={styles.more} color={color.accent} />
            : null
        }
        ListEmptyComponent={
          initialLoad
            ? <LoadingState label="Loading history…" />
            : error
              ? <ErrorState title="Couldn't load history" message={error} onRetry={() => load(0)} />
              : search
                ? <EmptyState icon="search-outline" title="No commits match" message={`Nothing matches “${search}”.`} />
                : <EmptyState icon="git-commit-outline" title="No commits yet" message="Commits on this branch show up here." />
        }
      />

      <CommitDiffSheet commit={diff} onClose={() => setDiff(null)} />

      <CommitMenu
        commit={menuFor}
        onClose={() => setMenuFor(null)}
        onView={(c) => setDiff(c)}
        onBranch={(c, name) => act('Create branch', `Created “${name}” at ${c.short}`, () =>
          conn!.req<Res>('git-branch-at', { branch: name, hash: c.hash }))}
        onTag={(c, name) => act('Tag', `Tagged ${c.short} as ${name}`, () =>
          conn!.req<Res>('git-tag', { name, hash: c.hash }))}
        onCherryPick={(c) => act('Cherry-pick', `Cherry-picked ${c.short}`, () =>
          conn!.req<Res>('git-cherry-pick', c.hash))}
        onBrowse={browse}
        onRevert={revert}
        onUndo={undo}
        onReset={resetTo}
      />
    </View>
  );
}

function CommitRow({ c, busy, onPress, onMenu, onQuick }: {
  c: Commit;
  busy: boolean;
  onPress: () => void;
  onMenu: () => void;
  onQuick: () => void;
}) {
  const unpushed = !c.incoming && !c.pushed;
  const quick = quickCommitAction(c);
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        c.incoming && styles.rowIncoming,
        unpushed && styles.rowUnpushed,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
      onLongPress={onMenu}
      accessibilityRole="button"
      accessibilityLabel={`${c.subject}. ${c.author}, ${c.relDate}${c.incoming ? '. Incoming' : unpushed ? '. Not pushed' : ''}`}
      accessibilityHint="Shows the commit's changes. Long-press for more actions."
    >
      {/* Direction icon, colour-matched to the row's left stripe: an unpushed commit is
          going up to the remote, an incoming one comes down on the next pull. A pushed
          commit gets an empty slot so subjects stay aligned. */}
      <View style={styles.dir}>
        {c.incoming && <Ionicons name="arrow-down" size={13} color={color.accent} />}
        {unpushed && <Ionicons name="arrow-up" size={13} color={color.fileYellow} />}
      </View>

      <View style={styles.main}>
        <Text style={styles.subject} numberOfLines={1}>{c.subject}</Text>
        <Text style={styles.meta} numberOfLines={1}>{meta(c)}</Text>
      </View>

      {!!quick && (
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
          disabled={busy}
          hitSlop={4}
          onPress={onQuick}
          accessibilityRole="button"
          accessibilityLabel={quick === 'undo' ? 'Undo this commit' : 'Revert this commit'}
          accessibilityState={{ disabled: busy }}
        >
          <Ionicons
            name={quick === 'undo' ? 'arrow-undo-outline' : 'refresh-outline'}
            size={16}
            color={busy ? color.faint : color.fileRed}
          />
        </Pressable>
      )}
      <Pressable
        style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
        disabled={busy}
        hitSlop={4}
        onPress={onMenu}
        accessibilityRole="button"
        accessibilityLabel="More commit actions"
        accessibilityState={{ disabled: busy }}
      >
        <Ionicons name="ellipsis-horizontal" size={16} color={busy ? color.faint : color.muted} />
      </Pressable>
    </Pressable>
  );
}

// The desktop's commit context menu as a bottom sheet. "Create branch here…" and
// "Tag…" swap the list for a name field in the same sheet (see GitSheets.tsx). The
// sheet closes before an action runs so its toast or error isn't hidden behind it;
// confirmations are Alerts, which do show over it.
function CommitMenu({
  commit, onClose, onView, onBranch, onTag, onCherryPick, onBrowse, onRevert, onUndo, onReset,
}: {
  commit: Commit | null;
  onClose: () => void;
  onView: (c: Commit) => void;
  onBranch: (c: Commit, name: string) => void;
  onTag: (c: Commit, name: string) => void;
  onCherryPick: (c: Commit) => void;
  onBrowse: (c: Commit) => void;
  onRevert: (c: Commit) => void;
  onUndo: (c: Commit) => void;
  onReset: (c: Commit, mode: 'soft' | 'hard') => void;
}) {
  const [step, setStep] = useState<'menu' | 'branch' | 'tag'>('menu');
  useEffect(() => { if (commit) setStep('menu'); }, [commit]);
  const { schedule, onDismiss } = useAfterDismiss();
  // Keep drawing the last commit while the sheet slides away, rather than an empty frame.
  const lastCommit = useRef<Commit | null>(null);
  if (commit) lastCommit.current = commit;
  const shown = commit ?? lastCommit.current;
  if (!shown) return null;

  const then = (fn: (c: Commit) => void) => () => { onClose(); fn(shown); };
  const entries: Record<string, SheetAction> = {
    // The diff is another Modal, so it waits for this one to finish closing.
    view: { key: 'view', label: 'View changes', icon: 'document-text-outline', onPress: () => { onClose(); schedule(() => onView(shown)); } },
    branch: { key: 'branch', label: 'Create branch here…', icon: 'git-branch-outline', onPress: () => setStep('branch') },
    tag: { key: 'tag', label: 'Tag this commit…', icon: 'pricetag-outline', onPress: () => setStep('tag') },
    'cherry-pick': { key: 'cherry-pick', label: 'Cherry-pick onto current branch', icon: 'git-pull-request-outline', onPress: then(onCherryPick) },
    browse: { key: 'browse', label: 'Open commit on GitHub', icon: 'logo-github', hint: 'Opens in the desktop browser', onPress: then(onBrowse) },
    revert: { key: 'revert', label: 'Revert this commit', icon: 'refresh-outline', destructive: true, onPress: then(onRevert) },
    undo: { key: 'undo', label: 'Undo this commit', icon: 'arrow-undo-outline', destructive: true, onPress: then(onUndo) },
    'reset-soft': {
      key: 'reset-soft', label: 'Reset branch here (soft)', icon: 'return-up-back-outline', destructive: true,
      hint: 'Later commits dropped, their changes kept staged', onPress: then((c) => onReset(c, 'soft')),
    },
    'reset-hard': {
      key: 'reset-hard', label: 'Reset branch here (hard)', icon: 'trash-bin-outline', destructive: true,
      hint: 'Later commits and all uncommitted changes deleted', onPress: then((c) => onReset(c, 'hard')),
    },
  };

  return (
    <Sheet open={!!commit} onClose={onClose} onDismiss={onDismiss} title={shown.subject} subtitle={meta(shown)}>
      {step === 'menu' && <ActionList actions={commitActionKeys(shown).map((k: string) => entries[k])} />}
      {step === 'branch' && (
        <PromptForm
          label="New branch name"
          placeholder="fix/my-branch"
          confirmLabel="Create branch"
          normalize={normalizeBranchName}
          onSubmit={(name) => { onClose(); onBranch(shown, name); }}
        />
      )}
      {step === 'tag' && (
        <PromptForm
          label="Tag name"
          placeholder="v1.0.0"
          confirmLabel="Tag"
          onSubmit={(name) => { onClose(); onTag(shown, name); }}
        />
      )}
    </Sheet>
  );
}

// Full patch of one commit, fetched only when a row is tapped — the list itself never
// carries diffs.
function CommitDiffSheet({ commit, onClose }: { commit: Commit | null; onClose: () => void }) {
  const { conn } = useConnection();
  const [patch, setPatch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!commit || !conn) return;
    // Tapping A then B fires two fetches; if A resolves last it must not paint over B's
    // patch. Drop a superseded run, exactly as the list's `gen` stamp does.
    let cancelled = false;
    setPatch('');
    setError('');
    setLoading(true);
    conn.req<Res>('git-commit-diff', commit.hash)
      .then((r) => {
        if (cancelled) return;
        if (r?.ok) setPatch(r.stdout || '');
        else setError(r?.stderr || 'Could not load the diff.');
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [commit, conn, attempt]);

  return (
    <DiffSheet
      open={!!commit}
      title={commit?.subject ?? ''}
      subtitle={commit ? meta(commit) : undefined}
      patch={patch}
      loading={loading}
      error={error}
      emptyLabel="This commit changes no file contents"
      onClose={onClose}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
  pressed: { backgroundColor: color.raised },

  // Same 40px control height as the Changes list's commit bar, so switching tabs
  // doesn't shift the body.
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 40,
    marginHorizontal: 16, marginBottom: 8, paddingLeft: 10, paddingRight: 2,
    borderRadius: 10, backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
  },
  search: { flex: 1, color: color.text, paddingVertical: 0, fontSize: 14 },

  error: { color: color.fileRed, paddingHorizontal: 16, paddingBottom: 8, fontSize: 12 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 52,
    paddingLeft: 9, paddingRight: 6, paddingVertical: 6,
    borderLeftWidth: 3, borderLeftColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderSoft,
  },
  rowUnpushed: { borderLeftColor: color.fileYellow },
  rowIncoming: { borderLeftColor: color.accent },
  dir: { width: 14, marginRight: 4, alignItems: 'center' },

  main: { flex: 1, minWidth: 0 },
  subject: { color: color.text, fontSize: 14 },
  meta: { color: color.muted, fontSize: 11, marginTop: 2 },

  // 36 + a 4pt hitSlop each side = 44pt touch target.
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  iconBtnPressed: { backgroundColor: color.raised },

  more: { marginVertical: 12 },
});
