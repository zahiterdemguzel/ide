// Claude sessions of the open project: list, create, resume, archive, delete.
// Mirrors the desktop sessions panel: Active/Archived/All tabs, newest-first, and a
// search bar on the Archived tab.
//
// The list is *paged*, not held whole: `query-sessions` returns one screenful at a
// time (tab-filtered, searched and sorted in main), and scrolling to the bottom asks
// for the next page. An archive of hundreds of sessions is never fetched in full,
// and the search filters in main so only matching rows come over the wire.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, Alert, ActivityIndicator, Modal,
  Animated, Easing, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import StateDot from '../components/StateDot';
import { MODELS, DEFAULT_MODEL, getSessionModel, setSessionModel, modelSuffix } from '../api/models';

const PAGE = 30;
// Safety net behind the sessions-changed push: a dropped socket or a missed event
// would otherwise leave the list stale until the next manual pull.
const POLL_MS = 5000;
// Typing shouldn't fire a round trip per keystroke; the desktop debounces its own
// archived search the same way.
const SEARCH_DEBOUNCE_MS = 200;

type Session = {
  id: string; repo: string; firstPrompt: string; name: string;
  archived: boolean; state: string; model: string; live: boolean; controlled: boolean;
};
type Counts = { active: number; archived: number; all: number };
type Page = { items: Session[]; total: number; counts: Counts };

type Tab = 'active' | 'archived' | 'all';
const TABS: { key: Tab; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

const NO_COUNTS: Counts = { active: 0, archived: 0, all: 0 };

// How collapsed the model menu starts, matching the desktop's `scaleY(0.85)`.
const MENU_SCALE = 0.85;

export default function SessionsScreen({ navigation }: any) {
  const { conn } = useConnection();
  const [items, setItems] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts>(NO_COUNTS);
  const [repo, setRepo] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('active');
  const [loadingMore, setLoadingMore] = useState(false);

  // The model a new session spawns with: the last one picked from the caret menu,
  // shown on the button so it's clear what a plain tap will use.
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  useEffect(() => { getSessionModel().then(setModel); }, []);

  // The model menu, animated like the desktop's: a dropdown played in reverse —
  // it grows *upward* out of the button it's anchored above. React Native ships no
  // menu widget, so this is Modal + Animated (the official primitives) reproducing
  // the CSS in layout.css: opacity 0→1, translateY(8px)→0, scaleY(0.85)→1 over
  // 140ms. RN transforms are center-origin, so the bottom-origin of the CSS is
  // faked by offsetting translateY by the height the scaleY collapse eats
  // (h * (1 - 0.85) / 2) — hence the measured height.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuHeight, setMenuHeight] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;

  const slide = (to: number, done?: () => void) => Animated.timing(anim, {
    toValue: to,
    duration: to ? 140 : 120,
    easing: Easing.out(Easing.quad),
    useNativeDriver: true,
  }).start(done);

  const openMenu = () => { setMenuOpen(true); slide(1); };
  // Unmount only once the menu has finished collapsing, the way the desktop waits
  // for transitionend before setting [hidden].
  const closeMenu = (then?: () => void) => slide(0, () => { setMenuOpen(false); then?.(); });

  const menuStyle = {
    opacity: anim,
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [8 + (menuHeight * (1 - MENU_SCALE)) / 2, 0],
        }),
      },
      { scaleY: anim.interpolate({ inputRange: [0, 1], outputRange: [MENU_SCALE, 1] }) },
    ],
  };

  // Raw input vs the query actually sent — debounced so a round trip isn't fired per
  // keystroke.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Mirrors of the paging state, so the callbacks below can read how much is loaded
  // without being rebuilt (and re-registering their listeners) on every page.
  const loaded = useRef(0);
  const totalRef = useRef(0);
  loaded.current = items.length;
  totalRef.current = total;

  // One request at a time: a poll tick landing on a push, or a load-more landing on a
  // refresh, is dropped rather than raced. Whatever it misses, the next tick re-runs.
  const busy = useRef(false);

  // Refetch from the top, keeping however many pages are already open so scrolling
  // back up doesn't hit a hole.
  const refetch = useCallback(async (size: number) => {
    if (!conn || conn.state !== 'ready' || busy.current) return;
    busy.current = true;
    try {
      const [page, repoPath] = await Promise.all([
        conn.req<Page>('query-sessions', { tab, query, offset: 0, limit: size }),
        conn.req<string | null>('get-repo-path'),
      ]);
      setRepo(repoPath);
      setItems(page.items);
      setTotal(page.total);
      setCounts(page.counts);
    } catch {
      // Socket dropped mid-request; the reconnect's 'ready' re-runs this.
    } finally {
      busy.current = false;
    }
  }, [conn, tab, query]);

  const refresh = useCallback(
    () => refetch(Math.max(PAGE, loaded.current)),
    [refetch],
  );

  const loadMore = useCallback(async () => {
    const offset = loaded.current;
    if (!conn || conn.state !== 'ready' || busy.current || offset >= totalRef.current) return;
    busy.current = true;
    setLoadingMore(true);
    try {
      const page = await conn.req<Page>('query-sessions', { tab, query, offset, limit: PAGE });
      // A refresh may have replaced the list while this page was in flight; appending
      // then would duplicate or misorder rows, so drop it — the list is already fresh.
      setItems((prev) => (prev.length === offset ? [...prev, ...page.items] : prev));
      setTotal(page.total);
      setCounts(page.counts);
    } catch {
      // Same as above: the next refresh recovers.
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [conn, tab, query]);

  // Switching tab or query invalidates the page: drop what's loaded and fetch the
  // first page of the new view. (`refetch` changes identity exactly when tab/query do.)
  useEffect(() => {
    setItems([]);
    setTotal(0);
    refetch(PAGE);
  }, [refetch]);

  useEffect(() => {
    const patch = (id: string, fields: Partial<Session>) =>
      setItems((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));
    const offs = [
      conn?.on('status', ({ id, state }: any) => patch(id, { state })),
      conn?.on('session-name', ({ id, name }: any) => patch(id, { name })),
      // Main pushes this whenever the set changes (created / archived / restored /
      // deleted / evicted), from whichever client made it. It carries no payload for
      // remote clients — the list is paged, so it's purely a "refetch" signal.
      conn?.on('sessions-changed', () => refresh()),
      // Switching project (here or on the desktop) re-scopes the list.
      conn?.on('folder-changed', () => refresh()),
      // Reconnecting means any change made while the socket was down was missed.
      conn?.onState((s) => { if (s === 'ready') refresh(); }),
    ];
    return () => offs.forEach((off) => off?.());
  }, [conn, refresh]);

  // Refetch whenever the tab is opened, then keep polling while it's on screen. The
  // tab navigator keeps this screen mounted, so a mount effect alone would never
  // re-run on a revisit.
  useFocusEffect(
    useCallback(() => {
      refresh();
      const timer = setInterval(refresh, POLL_MS);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  // The search bar lives on the Archived tab only; leaving it clears the filter.
  const selectTab = (t: Tab) => {
    setTab(t);
    if (t !== 'archived') setSearch('');
  };

  const newSession = async (chosen?: string) => {
    const model = chosen ?? (await getSessionModel());
    if (chosen) await setSessionModel(chosen);
    setModel(model);
    try {
      const r: any = await conn?.req('new-session', { cols: 80, rows: 30, model });
      // The desktop wraps handler failures in { error } instead of rejecting.
      if (r?.error || !r?.id) {
        Alert.alert('Could not create session', r?.error ?? 'Unknown error');
        return;
      }
      navigation.navigate('Chat', { id: r.id });
    } catch (e: any) {
      Alert.alert('Could not create session', e?.message ?? String(e));
    } finally {
      refresh();
    }
  };

  // A session with no Claude process behind it has nowhere to put a message, so
  // opening it as-is gives you a conversation you can read but not continue. That is
  // not only the archived case: every session restored from disk comes back without a
  // PTY, and the desktop only respawns one when someone clicks its row. Resume on
  // `live`, not on `archived` — main spawns it headlessly and pushes sessions-changed,
  // so the desktop follows along without anyone opening the session there.
  const open = async (s: Session) => {
    if (!s.live) await conn?.req('resume-session', { id: s.id, cols: 80, rows: 30 });
    navigation.navigate('Chat', { id: s.id, name: title(s) });
  };

  const archive = (s: Session) => {
    conn?.send('suspend-session', { id: s.id });
    setItems((prev) => prev.map((x) => (x.id === s.id ? { ...x, archived: true } : x)));
    refresh();
  };

  const unarchive = async (s: Session) => {
    await conn?.req('resume-session', { id: s.id, cols: 80, rows: 30 });
    refresh();
  };

  const remove = (s: Session) => {
    Alert.alert(
      'Delete session?',
      `“${title(s)}” will be permanently deleted. Its conversation cannot be restored.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            conn?.send('kill-session', { id: s.id });
            setItems((prev) => prev.filter((x) => x.id !== s.id));
            refresh();
          },
        },
      ],
    );
  };

  const emptyText = useMemo(() => {
    if (!repo) return 'Open a project first.';
    if (tab === 'archived') {
      return query ? `No archived sessions match “${query}”.` : 'No archived sessions.';
    }
    return 'No sessions yet — tap New session.';
  }, [repo, tab, query]);

  return (
    <View style={styles.fill}>
      <View style={styles.tabs}>
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <Pressable
              key={t.key}
              style={[styles.tab, on && styles.tabOn]}
              onPress={() => selectTab(t.key)}
            >
              <Text style={[styles.tabLabel, on && styles.tabLabelOn]}>{t.label}</Text>
              <Text style={[styles.tabCount, on && styles.tabCountOn]}>{counts[t.key]}</Text>
            </Pressable>
          );
        })}
      </View>

      {tab === 'archived' && (
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={16} color="#6e7681" />
          <TextInput
            style={styles.search}
            value={search}
            onChangeText={setSearch}
            placeholder="Search archived sessions"
            placeholderTextColor="#6e7681"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={16} color="#6e7681" />
            </Pressable>
          )}
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(s) => s.id}
        refreshing={false}
        onRefresh={refresh}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={items.length ? undefined : styles.fill}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => open(item)}
          >
            <View style={styles.dotSlot}>
              <StateDot state={item.state} size={10} />
            </View>
            <Text
              style={[styles.name, item.archived && styles.nameArchived]}
              numberOfLines={1}
            >
              {title(item)}
            </Text>
            {item.archived ? (
              <>
                <IconBtn name="arrow-up-circle-outline" label="Restore" onPress={() => unarchive(item)} />
                <IconBtn name="trash-outline" label="Delete" danger onPress={() => remove(item)} />
              </>
            ) : (
              <IconBtn name="archive-outline" label="Archive" onPress={() => archive(item)} />
            )}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
        ListFooterComponent={
          loadingMore ? <ActivityIndicator style={styles.more} color="#7d8590" /> : null
        }
      />

      <View style={styles.newWrap}>
        <Pressable
          style={({ pressed }) => [
            styles.new, styles.newMain, !repo && styles.newOff, pressed && repo && styles.newPressed,
          ]}
          onPress={() => newSession()}
          disabled={!repo}
        >
          <Ionicons name="add" size={20} color={repo ? '#fff' : '#7d8590'} />
          <Text style={[styles.newLabel, !repo && styles.newLabelOff]} numberOfLines={1}>
            New session{modelSuffix(model)}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.new, styles.newCaret, !repo && styles.newOff, pressed && repo && styles.newPressed,
          ]}
          onPress={openMenu}
          disabled={!repo}
          accessibilityLabel="Choose model"
        >
          <Ionicons name="chevron-up" size={18} color={repo ? '#fff' : '#7d8590'} />
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="none" onRequestClose={() => closeMenu()}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable style={styles.fill} onPress={() => closeMenu()} />
          <Animated.View
            style={[styles.menu, menuStyle]}
            onLayout={(e) => setMenuHeight(e.nativeEvent.layout.height)}
          >
            {MODELS.filter((m) => m.id !== DEFAULT_MODEL).map((m) => (
              <Pressable
                key={m.id}
                style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                onPress={() => closeMenu(() => newSession(m.id))}
              >
                <Text style={[styles.menuLabel, m.id === model && styles.menuLabelOn]}>{m.name}</Text>
                {m.id === model && <Ionicons name="checkmark" size={16} color="#4da3ff" />}
              </Pressable>
            ))}
          </Animated.View>
        </Animated.View>
      </Modal>
    </View>
  );
}

function title(s: Session) {
  return s.name || s.firstPrompt || 'Unnamed session';
}

function IconBtn(
  { name, label, onPress, danger }:
  { name: any; label: string; onPress: () => void; danger?: boolean },
) {
  return (
    <Pressable
      style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={label}
    >
      <Ionicons name={name} size={19} color={danger ? '#e06c75' : '#7d8590'} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },

  tabs: {
    flexDirection: 'row', gap: 6, padding: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
    backgroundColor: '#161b22', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  tabOn: { backgroundColor: '#1f6feb22', borderColor: '#4da3ff' },
  tabLabel: { color: '#7d8590', fontSize: 13, fontWeight: '600' },
  tabLabelOn: { color: '#4da3ff' },
  tabCount: { color: '#57606a', fontSize: 12, fontVariant: ['tabular-nums'] },
  tabCountOn: { color: '#4da3ff' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 10, marginBottom: 10, paddingHorizontal: 10,
    borderRadius: 8, backgroundColor: '#0d1117',
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  search: { flex: 1, paddingVertical: 8, color: '#e6edf3', fontSize: 14 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#21262d',
  },
  rowPressed: { backgroundColor: '#161b22' },
  // Fixed slot: the working ring is wider than the resting dot, and without this the
  // row's text would nudge sideways every time a session started or stopped.
  dotSlot: { width: 13, alignItems: 'center' },
  name: { flex: 1, color: '#e6edf3', fontSize: 15 },
  nameArchived: { color: '#7d8590' },

  iconBtn: { padding: 6, borderRadius: 6 },
  iconBtnPressed: { backgroundColor: '#21262d' },

  empty: { color: '#7d8590', textAlign: 'center', marginTop: 48, paddingHorizontal: 24 },
  more: { paddingVertical: 16 },

  // Split button: the wide half creates with the remembered model, the caret half
  // opens the picker — same shape as the desktop's #new-session / caret pair.
  newWrap: { flexDirection: 'row', gap: 2, margin: 12 },
  new: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, backgroundColor: '#238636',
  },
  newMain: { flex: 1, borderTopLeftRadius: 8, borderBottomLeftRadius: 8 },
  newCaret: { paddingHorizontal: 16, borderTopRightRadius: 8, borderBottomRightRadius: 8 },
  newPressed: { backgroundColor: '#2ea043' },
  newOff: { backgroundColor: '#161b22', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d' },
  newLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  newLabelOff: { color: '#7d8590' },

  // The tap-to-dismiss area fills everything above the menu, so the menu itself
  // sits just above the button it grew out of.
  backdrop: { flex: 1, backgroundColor: '#00000080' },
  menu: {
    margin: 12, marginBottom: 78, borderRadius: 8, overflow: 'hidden',
    backgroundColor: '#161b22', borderWidth: StyleSheet.hairlineWidth, borderColor: '#30363d',
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#21262d',
  },
  menuItemPressed: { backgroundColor: '#21262d' },
  menuLabel: { color: '#e6edf3', fontSize: 15 },
  menuLabelOn: { color: '#4da3ff', fontWeight: '600' },
});
