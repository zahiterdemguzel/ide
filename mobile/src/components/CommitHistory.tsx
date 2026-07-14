// Commit history for the Git tab: browse, search, and undo/revert a commit.
// Mirrors the desktop History tab (src/renderer/git-pane.js) and main's git-log /
// git-commit-diff / git-undo-commit / git-revert-commit channels.
//
// A commit's state decides its action, exactly as on the desktop:
//   • incoming — on the upstream, not local yet; a pull brings it in. No action.
//   • unpushed — local only, so history can be safely rewritten: UNDO drops it.
//   • pushed   — on the remote; rewriting would diverge, so REVERT lands a new
//                commit that undoes it.
// Undo needs no confirmation (nothing has left the machine, and its changes come
// back staged, so it's recoverable); revert writes a new commit everyone will see,
// so it confirms first.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, TextInput, Modal,
  ActivityIndicator, Alert, ScrollView, StyleSheet,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';

export type Commit = {
  hash: string; short: string; subject: string; author: string; relDate: string;
  pushed?: boolean; incoming?: boolean;
};
type LogRes = { ok: boolean; error?: string; commits: Commit[]; incoming: Commit[]; hasMore: boolean };
type Res = { ok: boolean; stdout?: string; stderr?: string };

// Commits per request. Small enough that the first screen paints immediately on a
// phone, large enough that a scroll rarely waits on the next page.
const PAGE = 30;

export default function CommitHistory({ onChanged }: { onChanged: () => void }) {
  const { conn } = useConnection();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [incoming, setIncoming] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [diff, setDiff] = useState<Commit | null>(null);

  // Typing shouldn't fire a git log per keystroke; search only after a pause.
  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // Every load is stamped: a slower reply from a superseded query (or an earlier
  // page) must not overwrite the newer one, so stale responses are dropped.
  const gen = useRef(0);
  const load = useCallback(async (skip: number) => {
    if (!conn || conn.state !== 'ready') return;
    const mine = ++gen.current;
    setLoading(true);
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
      if (mine === gen.current) setLoading(false);
    }
  }, [conn, search]);

  // Reload from the top whenever the query settles (and once on mount).
  useEffect(() => { load(0); }, [load]);

  // Paging key: skip by what we already hold. With a query, main pages the *matches*,
  // so this stays correct — commits.length is the number of matches already shown.
  const loadMore = () => { if (hasMore && !loading) load(commits.length); };

  // A rewrite/revert changes both the log and the working tree (undo leaves the
  // commit's changes staged), so refresh the history and tell the parent to refetch
  // git-status. Failures surface git's stderr — main reports them as ok:false, and a
  // conflicting rebase is aborted there, so the tree is left clean.
  const act = async (label: string, ch: string, hash: string) => {
    setBusy(true);
    try {
      const r = await conn!.req<Res>(ch, hash);
      if (r && r.ok === false) Alert.alert(label, r.stderr || `${label} failed`);
    } catch (e: any) {
      Alert.alert(label, String(e?.message ?? e));
    }
    setBusy(false);
    load(0);
    onChanged();
  };

  const undo = (c: Commit) => act('Undo commit', 'git-undo-commit', c.hash);

  const revert = (c: Commit) =>
    Alert.alert(
      'Revert commit',
      `Revert “${c.subject}”?\n\nThis is already pushed, so its history can't be rewritten. Reverting lands a new commit that undoes its changes.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Revert', style: 'destructive', onPress: () => act('Revert commit', 'git-revert-commit', c.hash) },
      ],
    );

  // Incoming commits sit above the local log, as on the desktop: they're a preview of
  // what the next pull brings in. They only come back on an unfiltered first page.
  const data = [...incoming, ...commits];

  return (
    <View style={styles.fill}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={15} color="#6e7681" />
        <TextInput
          style={styles.search}
          placeholder="Search message, author, or hash"
          placeholderTextColor="#6e7681"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!query && (
          <Pressable style={styles.iconBtn} onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={16} color="#6e7681" />
          </Pressable>
        )}
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <FlatList
        data={data}
        keyExtractor={(c) => c.hash}
        keyboardShouldPersistTaps="handled"
        refreshing={false}
        onRefresh={() => load(0)}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        renderItem={({ item }) => (
          <CommitRow
            c={item}
            busy={busy}
            onPress={() => setDiff(item)}
            onUndo={() => undo(item)}
            onRevert={() => revert(item)}
          />
        )}
        ListFooterComponent={
          loading && commits.length > 0
            ? <ActivityIndicator style={styles.more} color="#4da3ff" />
            : null
        }
        ListEmptyComponent={
          loading
            ? <ActivityIndicator style={styles.loading} color="#4da3ff" />
            : <Text style={styles.empty}>{search ? 'No commits match.' : 'No commits yet.'}</Text>
        }
      />

      <DiffSheet commit={diff} onClose={() => setDiff(null)} />
    </View>
  );
}

function CommitRow({ c, busy, onPress, onUndo, onRevert }: {
  c: Commit;
  busy: boolean;
  onPress: () => void;
  onUndo: () => void;
  onRevert: () => void;
}) {
  const unpushed = !c.incoming && !c.pushed;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        c.incoming && styles.rowIncoming,
        unpushed && styles.rowUnpushed,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      {/* Direction icon, colour-matched to the row's left stripe: an unpushed commit is
          going up to the remote, an incoming one comes down on the next pull. A pushed
          commit gets an empty slot so subjects stay aligned. */}
      <View style={styles.dir}>
        {c.incoming && <Ionicons name="arrow-down" size={13} color="#4da3ff" />}
        {unpushed && <Ionicons name="arrow-up" size={13} color="#e5c07b" />}
      </View>

      <View style={styles.main}>
        <Text style={styles.subject} numberOfLines={1}>{c.subject}</Text>
        <Text style={styles.meta} numberOfLines={1}>{c.short} · {c.author} · {c.relDate}</Text>
      </View>

      {/* An incoming commit isn't in our history yet, so there's nothing to undo. */}
      {!c.incoming && (
        <Pressable
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
          disabled={busy}
          onPress={unpushed ? onUndo : onRevert}
        >
          <Ionicons
            name={unpushed ? 'arrow-undo-outline' : 'refresh-outline'}
            size={16}
            color={busy ? '#6e7681' : '#e06c75'}
          />
        </Pressable>
      )}
    </Pressable>
  );
}

// Full patch of one commit, fetched only when a row is tapped — the list itself never
// carries diffs. Patches are wide, so the body scrolls both ways.
function DiffSheet({ commit, onClose }: { commit: Commit | null; onClose: () => void }) {
  const { conn } = useConnection();
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!commit || !conn) return;
    setPatch('');
    setLoading(true);
    conn.req<Res>('git-commit-diff', commit.hash)
      .then((r) => setPatch(r?.ok ? (r.stdout || '') : (r?.stderr || 'Could not load the diff.')))
      .catch((e) => setPatch(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [commit, conn]);

  return (
    <Modal visible={!!commit} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <View style={styles.main}>
            <Text style={styles.sheetTitle} numberOfLines={1}>{commit?.subject}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {commit?.short} · {commit?.author} · {commit?.relDate}
            </Text>
          </View>
          <Pressable style={styles.iconBtn} onPress={onClose}>
            <Ionicons name="close" size={20} color="#7d8590" />
          </Pressable>
        </View>

        {loading
          ? <ActivityIndicator style={styles.loading} color="#4da3ff" />
          : (
            <ScrollView>
              <ScrollView horizontal>
                <Text style={styles.patch}>{patch}</Text>
              </ScrollView>
            </ScrollView>
          )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pressed: { backgroundColor: '#21262d' },

  // Same 8px gutter and 40px control height as the Changes list and its commit bar,
  // so switching tabs doesn't shift the body.
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 40,
    marginHorizontal: 10, marginTop: 8, marginBottom: 8, paddingLeft: 10, paddingRight: 4,
    borderRadius: 8, backgroundColor: '#161b22',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  search: { flex: 1, color: '#e6edf3', paddingVertical: 0, fontSize: 14 },

  error: { color: '#e06c75', padding: 10 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 9, paddingRight: 6, paddingVertical: 9,
    borderLeftWidth: 3, borderLeftColor: 'transparent',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#21262d',
  },
  rowUnpushed: { borderLeftColor: '#e5c07b' },
  rowIncoming: { borderLeftColor: '#4da3ff' },
  dir: { width: 14, alignItems: 'center' },

  main: { flex: 1 },
  subject: { color: '#e6edf3', fontSize: 14 },
  meta: { color: '#7d8590', fontSize: 11, marginTop: 2 },

  iconBtn: { padding: 6, borderRadius: 6 },
  iconBtnPressed: { backgroundColor: '#21262d' },

  loading: { marginVertical: 24 },
  more: { marginVertical: 12 },
  empty: { color: '#7d8590', textAlign: 'center', marginTop: 48 },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000a' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, top: '12%',
    backgroundColor: '#0d1117', borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#30363d', paddingBottom: 16,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  sheetTitle: { color: '#e6edf3', fontSize: 15, fontWeight: '700' },
  patch: { color: '#e6edf3', fontFamily: 'monospace', fontSize: 12, padding: 12 },
});
