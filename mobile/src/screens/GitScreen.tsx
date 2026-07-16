// Git pane: status, stage/unstage, discard, branch switch/create, commit, push/pull.
// Mirrors the desktop git pane (src/renderer/git-pane.js) and its git-* IPC channels
// (same payload shapes as src/main/git.js). Destructive actions the desktop arms with a
// two-click confirm use a destructive Alert here — there's no hover-to-arm on touch.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, SectionList, FlatList, Pressable, TextInput, Modal,
  ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import { newSessionWithPrompt } from '../api/session-prompt';
import CommitHistory from '../components/CommitHistory';
import FileIcon from '../components/FileIcon';
import ScreenHeader from '../components/ScreenHeader';
import { CategoryLabel, Divider } from '../components/ui';
import { showError } from '../components/ErrorDialog';
import { color, radius, font, shadow } from '../theme';

type Entry = { status: string; file: string };
type Status = {
  ok: boolean; error?: string; staged: Entry[]; unstaged: Entry[]; conflicts: Entry[];
  branch?: string; ahead?: number; behind?: number;
};
type Branch = { name: string; remote: boolean };
type Res = { ok: boolean; stdout?: string; stderr?: string; needsMerge?: boolean };

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

function mergePrompt(operation: string, errorText?: string) {
  const parts = [MERGE.prompt, `${MERGE.promptOp} ${operation}`];
  const err = (errorText || '').trim();
  if (err) parts.push(`${MERGE.promptError}\n${err}`);
  return parts.join('\n\n');
}

// Git branch names can't contain spaces; turn each run into a hyphen rather than
// rejecting the name. Mirrors normalizeBranchName in src/renderer/shared/git-status.js.
function normalizeBranchName(name: string) {
  return (name || '').trim().replace(/\s+/g, '-');
}

// A remote-only branch is checked out by its short name (`origin/feat` → `feat`) so
// git's DWIM creates a local tracking branch instead of detaching HEAD at the remote ref.
function checkoutName(b: Branch) {
  return b.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name;
}

// The porcelain code a row carries, as a letter and a colour. `?` (untracked) reads as
// "U" the way it does in VS Code — a bare question mark next to a filename looks like a
// missing icon rather than a status. Anything unrecognised keeps its own letter in grey.
const STATUS: Record<string, { letter: string; color: string }> = {
  M: { letter: 'M', color: color.fileYellow },
  A: { letter: 'A', color: color.fileGreen },
  D: { letter: 'D', color: color.fileRed },
  R: { letter: 'R', color: color.accent },
  C: { letter: 'C', color: color.accent },
  U: { letter: 'C', color: color.fileRed },
  '?': { letter: 'U', color: color.fileGreen },
};

function statusMeta(code: string) {
  const key = (code || '').trim().charAt(0);
  return STATUS[key] ?? { letter: key || '·', color: color.muted };
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

export default function GitScreen({ navigation }: any) {
  const { conn } = useConnection();
  const [status, setStatus] = useState<Status | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');

  const refresh = useCallback(async () => {
    if (!conn || conn.state !== 'ready') return;
    try { setStatus(await conn.req<Status>('git-status')); } catch { /* reconnect refetches */ }
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
    const offFolder = conn.on('folder-changed', () => refresh());
    return () => { offState(); offFolder(); };
  }, [conn, refresh]);

  // Every mutation funnels through here: it serializes on the busy flag, surfaces
  // git's stderr (git reports most failures as ok:false, not a throw), then refreshes.
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = (await fn()) as Res | undefined;
      if (r && r.ok === false) showError(label, r.stderr || `${label} failed`);
    } catch (e: any) {
      showError(label, e);
    }
    setBusy(false);
    refresh();
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
  const offerClaude = (title: string, message: string, operation: string, errorText?: string) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: MERGE.ok,
        onPress: async () => {
          try {
            const id = await newSessionWithPrompt(conn!, mergePrompt(operation, errorText));
            navigation.navigate('Chat', { id });
          } catch (e: any) {
            showError('Session', e);
          }
        },
      },
    ]);

  // Pull/push don't go through run(): a failure that's fixable by a merge is handed to
  // Claude rather than dumped as a wall of git text. main flags exactly that case with
  // `needsMerge` (a diverged branch / rejected push); anything else is a plain error.
  const sync = (label: string, ch: string, title: string, message: string, operation: string) =>
    run(label, async () => {
      const r = await conn!.req<Res>(ch);
      if (r && r.ok === false && r.needsMerge) {
        offerClaude(title, message, operation, r.stderr);
        return undefined; // handled — don't let run() also alert the raw error
      }
      return r;
    });

  const commit = () => {
    setWriting(!msg.trim());
    run('Commit', async () => {
      try {
        const r = await conn!.req<Res>('git-commit', msg.trim());
        if (r?.ok) setMsg('');
        return r;
      } finally {
        setWriting(false);
      }
    });
  };

  const revert = (item: Entry) =>
    Alert.alert('Discard changes', `Discard all changes to ${item.file}? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => run('Discard', () =>
          conn!.req('git-revert', { file: item.file, untracked: item.status === '?' })),
      },
    ]);

  // Discard every unstaged change at once — the desktop's "Changes" header button.
  // Staged files are deliberately left alone, same as the desktop.
  const revertAll = () => {
    const files = status?.unstaged ?? [];
    if (!files.length) return;
    Alert.alert(
      'Discard all changes',
      `Discard changes to all ${files.length} file${files.length === 1 ? '' : 's'}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard all',
          style: 'destructive',
          onPress: () => run('Discard all', async () => {
            for (const f of files) {
              await conn!.req('git-revert', { file: f.file, untracked: f.status === '?' });
            }
          }),
        },
      ],
    );
  };

  const stageAll = () => run('Stage all', async () => {
    for (const f of status?.unstaged ?? []) await conn!.req('git-stage', f.file);
  });

  // Empty sections are dropped rather than shown with a "(0)": on a phone a clean tree
  // should read as one calm empty state, not as two headers with nothing under them.
  const sections = (status ? [
    { key: 'conflicts', title: 'Conflicts', data: status.conflicts, staged: false, conflict: true },
    { key: 'staged', title: 'Staged', data: status.staged, staged: true, conflict: false },
    { key: 'unstaged', title: 'Changes', data: status.unstaged, staged: false, conflict: false },
  ] : []).filter((s) => s.data.length > 0);

  return (
    <View style={styles.fill}>
      {/* Titled like every other tab. The branch chip below names the branch, not the
          screen, so it isn't a substitute — and a frame that's a heading everywhere
          else and a bare toolbar here reads as the one screen that lost its title.
          The controls stay on the page rather than in the frame: they're styled to
          read as raised against it (see `branchBtn`). */}
      <ScreenHeader title="Git" />

      <View style={styles.controls}>
        {/* The branch / pull / push row stays put across both views — it's about the
            branch, not about what you're looking at. Only the body and the commit
            bar swap. */}
        <View style={styles.branchBar}>
          <Pressable
            style={({ pressed }) => [styles.branchBtn, pressed && styles.pressed]}
            onPress={() => setBranchOpen(true)}
          >
            <Ionicons name="git-branch-outline" size={15} color={color.accent} />
            <Text style={styles.branchName} numberOfLines={1}>{status?.branch || '—'}</Text>
            <Ionicons name="chevron-down" size={13} color={color.muted} />
          </Pressable>

          {/* The badge is a sibling of the button, not a child: Android clips children
              that overflow a parent with a border radius, which would crop the circle. */}
          <View style={styles.actionWrap}>
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.pressed, busy && styles.actionOff]}
              disabled={busy}
              onPress={() => sync('Pull', 'git-pull', MERGE.pullTitle, MERGE.pullMsg, MERGE.opPull)}
            >
              <Ionicons name="arrow-down-outline" size={15} color={busy ? color.faint : color.text} />
              <Text style={[styles.actionLabel, busy && styles.actionLabelOff]}>Pull</Text>
            </Pressable>
            <CountBadge n={status?.behind} />
          </View>

          <View style={styles.actionWrap}>
            <Pressable
              style={({ pressed }) => [styles.action, pressed && styles.pressed, busy && styles.actionOff]}
              disabled={busy}
              onPress={() => sync('Push', 'git-push', MERGE.pushTitle, MERGE.pushMsg, MERGE.opPush)}
            >
              <Ionicons name="arrow-up-outline" size={15} color={busy ? color.faint : color.text} />
              <Text style={[styles.actionLabel, busy && styles.actionLabelOff]}>Push</Text>
            </Pressable>
            <CountBadge n={status?.ahead} />
          </View>
        </View>

        <View style={styles.segments}>
          {(['changes', 'history'] as const).map((k) => (
            <Pressable
              key={k}
              style={[styles.segment, tab === k && styles.segmentOn]}
              onPress={() => setTab(k)}
            >
              <Text style={[styles.segmentLabel, tab === k && styles.segmentLabelOn]}>
                {k === 'changes' ? 'Changes' : 'History'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {status && !status.ok && <Text style={styles.error}>{status.error}</Text>}

      {tab === 'history' && <CommitHistory onChanged={refresh} />}

      {tab === 'changes' && <>
      <SectionList
        sections={sections}
        keyExtractor={(e, i) => e.file + i}
        refreshing={false}
        onRefresh={refresh}
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
                onPress={() => offerClaude(
                  MERGE.conflictsTitle, MERGE.conflictsMsg, MERGE.opResolve)}
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
                  style={({ pressed }) => [styles.headBtn, pressed && styles.iconBtnPressed]}
                  disabled={busy}
                  hitSlop={4}
                  onPress={revertAll}
                >
                  <Ionicons name="arrow-undo-outline" size={15} color={color.fileRed} />
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.headBtn, pressed && styles.iconBtnPressed]}
                  disabled={busy}
                  hitSlop={4}
                  onPress={stageAll}
                >
                  <Ionicons name="add" size={17} color={color.fileGreen} />
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
              onRevert={() => revert(item)}
              onToggle={() => run(section.staged ? 'Unstage' : 'Stage', () =>
                conn!.req(section.staged ? 'git-unstage' : 'git-stage', item.file))}
            />
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="checkmark-done-outline" size={34} color={color.border} />
            <Text style={styles.empty}>Working tree clean.</Text>
          </View>
        }
      />

      <View style={styles.commitBar}>
        <TextInput
          style={styles.input}
          placeholder="Message — Claude writes one"
          placeholderTextColor={color.faint}
          value={msg}
          onChangeText={setMsg}
        />
        <Pressable
          style={({ pressed }) => [
            styles.commit, pressed && styles.commitPressed,
            (busy || !dirty) && styles.commitOff,
          ]}
          disabled={busy || !dirty}
          onPress={commit}
        >
          {writing
            ? <ActivityIndicator size="small" color={color.muted} />
            : <Text style={[styles.commitLabel, !dirty && styles.commitLabelOff]}>Commit</Text>}
        </Pressable>
      </View>
      </>}

      <BranchSheet
        open={branchOpen}
        current={status?.branch || ''}
        onClose={() => setBranchOpen(false)}
        onPick={(b) => run('Switch branch', () => conn!.req('git-checkout', checkoutName(b)))}
        onCreate={(name) => run('Create branch', () => conn!.req('git-create-branch', name))}
        onDelete={(name) => run('Delete branch', () => conn!.req('git-delete-branch', name))}
      />
    </View>
  );
}

// One changed file. Laid out like a Files-tab row (icon, name, muted folder beneath) so
// the two lists read as the same app, with the porcelain code as a tinted letter chip and
// the actions as full-size tap targets rather than the bare glyphs they used to be.
function FileRow({ item, busy, staged, conflict, onRevert, onToggle }: {
  item: Entry;
  busy: boolean;
  staged: boolean;
  conflict: boolean;
  onRevert: () => void;
  onToggle: () => void;
}) {
  const { name, dir } = splitPath(item.file);
  const st = statusMeta(item.status);
  const deleted = st.letter === 'D';
  return (
    <View style={styles.row}>
      {/* A deleted file's icon would advertise a file that isn't there any more. */}
      <View style={[styles.rowIcon, deleted && styles.iconGone]}>
        <FileIcon name={name} size={17} />
      </View>

      <View style={styles.rowMain}>
        <Text style={[styles.file, deleted && styles.fileDeleted]} numberOfLines={1}>{name}</Text>
        {!!dir && <Text style={styles.dir} numberOfLines={1}>{dir}</Text>}
      </View>

      <View style={[styles.stat, { backgroundColor: `${st.color}1f`, borderColor: `${st.color}59` }]}>
        <Text style={[styles.statText, { color: st.color }]}>{st.letter}</Text>
      </View>

      {/* Conflicted files can't be staged or discarded piecemeal — resolving one
          is a deliberate edit, so they carry no actions (as on the desktop). */}
      {!conflict && (
        <>
          {!staged && (
            <Pressable
              style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
              disabled={busy}
              onPress={onRevert}
            >
              <Ionicons name="arrow-undo-outline" size={16} color="#e06c75" />
            </Pressable>
          )}
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
            disabled={busy}
            onPress={onToggle}
          >
            <Ionicons
              name={staged ? 'remove' : 'add'}
              size={18}
              color={staged ? '#e5c07b' : '#98c379'}
            />
          </Pressable>
        </>
      )}
    </View>
  );
}

// Commit count on the push/pull buttons: a green circle pinned to the top-right
// corner, mirroring the desktop's .git-ahead-badge / .git-behind-badge. The ring is
// the button-row background colour, so the circle reads as sitting *on* the corner
// rather than inside the button. Hidden at zero (nothing to push / pull).
function CountBadge({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <View style={styles.badge}>
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

  // Close first, then act: the action's Alert (on failure) must not fight the sheet.
  const act = (fn: () => void) => { onClose(); fn(); };

  const confirmDelete = (name: string) =>
    Alert.alert('Delete branch', `Delete branch “${name}”? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => act(() => onDelete(name)) },
    ]);

  return (
    <Modal visible={open} animationType="slide" transparent statusBarTranslucent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Branches</Text>
          <Pressable style={styles.iconBtn} onPress={onClose}>
            <Ionicons name="close" size={20} color="#7d8590" />
          </Pressable>
        </View>

        <TextInput
          style={styles.search}
          placeholder="Search or type a new branch name"
          placeholderTextColor="#6e7681"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {loading
          ? <ActivityIndicator style={styles.loading} color="#4da3ff" />
          : (
            <FlatList
              data={matches}
              keyExtractor={(b) => b.name}
              keyboardShouldPersistTaps="handled"
              ListHeaderComponent={canCreate ? (
                <Pressable
                  style={({ pressed }) => [styles.branchRow, pressed && styles.pressed]}
                  onPress={() => act(() => onCreate(newName))}
                >
                  <Ionicons name="add-circle-outline" size={16} color="#98c379" />
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
                  >
                    <Ionicons
                      name={isCurrent ? 'checkmark' : item.remote ? 'cloud-outline' : 'git-branch-outline'}
                      size={16}
                      color={isCurrent ? '#98c379' : '#7d8590'}
                    />
                    <Text style={[styles.branchLabel, isCurrent && styles.branchLabelOn]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {/* Git refuses to delete the checked-out branch, and a remote-tracking
                        branch isn't ours to delete locally — so only other locals get a trash. */}
                    {!isCurrent && !item.remote && (
                      <Pressable
                        style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
                        onPress={() => confirmDelete(item.name)}
                      >
                        <Ionicons name="trash-outline" size={15} color="#e06c75" />
                      </Pressable>
                    )}
                  </Pressable>
                );
              }}
            />
          )}
      </View>
    </Modal>
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
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
  branchName: { flex: 1, color: color.text, fontSize: 14, fontWeight: '600' },

  actionWrap: { position: 'relative' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.md,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
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
    flexDirection: 'row', backgroundColor: color.surface, borderRadius: 9, padding: 2,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 7 },
  segmentOn: { backgroundColor: color.raisedHi, ...shadow.thumb },
  segmentLabel: { color: color.muted, fontSize: 13, fontWeight: '600' },
  segmentLabelOn: { color: color.text },

  error: { color: color.fileRed, padding: 10 },

  grow: { flexGrow: 1 },
  // No top pad: every section header already carries its own (`section.paddingTop`),
  // and one here stacked on top of that — the first title sat under twice the gap of
  // the ones below it, which read as the list hanging off the switch.
  //
  // The bottom pad is the floating commit bar's height (42 + 10 either side) plus a
  // gap, so the last changed file scrolls clear of it instead of under it forever.
  listPad: { paddingHorizontal: 16, paddingBottom: 70 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },

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
    minHeight: 48, paddingLeft: 14, paddingRight: 6, paddingVertical: 6,
  },
  rowIcon: { width: 17, marginRight: 8, alignItems: 'center' },
  iconGone: { opacity: 0.45 },
  rowMain: { flex: 1, minWidth: 0 },
  file: { color: color.body, fontSize: font.size.md },
  fileDeleted: { color: color.muted, textDecorationLine: 'line-through' },
  dir: { color: color.faint, fontSize: 11, marginTop: 2 },

  stat: {
    width: 20, height: 20, borderRadius: 6, marginRight: 2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  statText: { fontSize: 11, fontWeight: '700', includeFontPadding: false },

  resolve: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill,
    backgroundColor: '#1f6feb22',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#4da3ff59',
  },
  resolvePressed: { backgroundColor: '#1f6feb44' },
  resolveLabel: { color: color.accent, fontSize: 12, fontWeight: '600' },

  headBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  iconBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  iconBtnPressed: { backgroundColor: color.raised },

  empty: { color: color.faint, fontSize: 13 },

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
  // `#0008` is the same black-at-alpha idiom as `scrim` below.
  //
  // A real frosted blur would be better here and isn't reachable: it needs `expo-blur`,
  // which is a native module — a new dependency and a rebuild of every dev client — so
  // this is the flat approximation of it.
  input: {
    flex: 1, height: 42, color: color.text,
    backgroundColor: '#0008',
    borderWidth: 1, borderColor: color.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 0, fontSize: 14,
  },
  commit: {
    minWidth: 84, height: 42, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, borderRadius: radius.md, backgroundColor: color.greenDeep,
  },
  commitPressed: { backgroundColor: '#2ea043' },
  commitOff: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  commitLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  commitLabelOff: { color: color.muted },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000a' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '75%',
    backgroundColor: '#0d1117', borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#30363d', paddingBottom: 16,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 16, paddingRight: 8, paddingVertical: 10,
  },
  sheetTitle: { flex: 1, color: '#e6edf3', fontSize: 16, fontWeight: '700' },
  search: {
    color: '#e6edf3', backgroundColor: '#161b22',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
    borderRadius: 8, marginHorizontal: 12, marginBottom: 8,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  loading: { marginVertical: 24 },
  sheetEmpty: { color: '#7d8590', textAlign: 'center', marginTop: 32 },
  branchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#21262d',
  },
  branchLabel: { flex: 1, color: '#e6edf3', fontSize: 14 },
  branchLabelOn: { color: '#98c379', fontWeight: '600' },
  createLabel: { flex: 1, color: '#98c379', fontSize: 14, fontWeight: '600' },
});
