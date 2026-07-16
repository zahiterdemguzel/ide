// Claude sessions of the open project: list, create, resume, archive, delete.
// Mirrors the desktop sessions panel: Active/Archived/All tabs, newest-first, and a
// search bar on the Archived tab.
//
// The list is *paged*, not held whole: `query-sessions` returns one screenful at a
// time (tab-filtered, searched and sorted in main), and scrolling to the bottom asks
// for the next page. An archive of hundreds of sessions is never fetched in full,
// and the search filters in main so only matching rows come over the wire.
//
// Rows are grouped by what they want from you — needs you, settled, working —
// rather than listed flat, so the one session asking a question can't be lost among
// twenty that aren't. The grouping is over the LOADED page, not the whole archive:
// main sorts newest-first and knows nothing of these categories, so a later page can
// add rows to a group already on screen. That's the intended read (the groups are a
// lens on what you've scrolled to), not a sync bug.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, SectionList, Pressable, Alert, ActivityIndicator, Modal,
  Animated, Easing, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import StateDot from '../components/StateDot';
import ScreenHeader from '../components/ScreenHeader';
import { Card, CategoryLabel, Pill, IconButton } from '../components/ui';
import { showError } from '../components/ErrorDialog';
import { shortAgo } from '../api/time';
import {
  MODELS, DEFAULT_MODEL, getSessionModel, setSessionModel, modelSuffix, modelBadgeName,
  OllamaModel,
} from '../api/models';
import { color, radius, font, type, motion, shadow, tint, TAB_BAR_HEIGHT } from '../theme';

const PAGE = 30;
// Safety net behind the sessions-changed push: a dropped socket or a missed event
// would otherwise leave the list stale until the next manual pull.
const POLL_MS = 5000;
// Typing shouldn't fire a round trip per keystroke; the desktop debounces its own
// archived search the same way.
const SEARCH_DEBOUNCE_MS = 200;

type Tool = { name: string; file: string | null };
type Session = {
  id: string; repo: string; firstPrompt: string; name: string;
  archived: boolean; state: string; model: string; effort: string;
  live: boolean;
  startedAt: number; lastActiveAt: number; tool: Tool | null;
  added: number; removed: number;
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

// The three things a session can be, in the order you care about them: the ones asking
// for you first, then everything settled/done, with the runs still in progress last.
// Every state main can report lands in exactly one — `settled` is the catch-all (its
// predicate excludes only the states the other groups own) so an unknown state still
// renders somewhere rather than vanishing from the list.
const GROUPS: { key: string; label: string; hue: string; is: (s: Session) => boolean }[] = [
  { key: 'needs', label: 'Needs you', hue: color.green, is: (s) => s.state === 'needs-input' },
  { key: 'settled', label: 'Settled', hue: color.muted, is: (s) => s.state !== 'working' },
  { key: 'working', label: 'Working', hue: color.yellow, is: (s) => s.state === 'working' },
];

// How collapsed the model menu starts, matching the desktop's `scaleY(0.85)`.
const MENU_SCALE = 0.85;

// The split button's own height (13px padding either side of a 20px icon) plus the
// gap under it, so the menu can be parked just above the button it grows out of.
const NEW_BUTTON_HEIGHT = 46;
const NEW_BUTTON_GAP = 12;
const MENU_GAP = 8;

export default function SessionsScreen({ navigation }: any) {
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
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

  // Installed Ollama custom models the desktop set up — the phone can pick them for
  // a new session but can't install/remove (management is desktop-only). Fetched
  // read-only and refreshed when the desktop installs/removes one.
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  useEffect(() => {
    if (!conn) return undefined;
    const load = () => conn.req<OllamaModel[]>('ollama-list').then((l) => setOllamaModels(l || [])).catch(() => {});
    load();
    return conn.on('ollama-models-changed', load);
  }, [conn]);

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

  // The menu lives in a Modal, which covers the tab bar — so where it sits is
  // measured from the window's bottom, not the screen's: clear the gesture inset,
  // then the tab bar, then the button it belongs to.
  const menuLift = insets.bottom + TAB_BAR_HEIGHT + NEW_BUTTON_GAP + NEW_BUTTON_HEIGHT + MENU_GAP;

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

  // The finished celebration, tracked here rather than in the row. A session going
  // working -> completed moves from the Working section to Settled, and SectionList
  // remounts the row when it changes section — so the row itself can never see the
  // transition. This map outlives that remount and tells the new row it just landed.
  const seenState = useRef(new Map<string, string>());
  const [justFinished, setJustFinished] = useState<Set<string>>(new Set());
  useEffect(() => {
    const landed = items
      .filter((s) => seenState.current.get(s.id) === 'working' && s.state === 'completed')
      .map((s) => s.id);
    seenState.current = new Map(items.map((s) => [s.id, s.state]));
    if (!landed.length) return undefined;
    setJustFinished((prev) => new Set([...prev, ...landed]));
    const timer = setTimeout(
      () => setJustFinished((prev) => new Set([...prev].filter((id) => !landed.includes(id)))),
      motion.flash,
    );
    return () => clearTimeout(timer);
  }, [items]);

  // The tool line and the relative times are only as fresh as the last render, and
  // both change on their own — so re-render on the same beat the list polls on.
  const [, tick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => tick((n) => n + 1), POLL_MS);
      return () => clearInterval(timer);
    }, []),
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
        showError('Could not create session', r?.error ?? 'Unknown error');
        return;
      }
      navigation.navigate('Chat', { id: r.id });
    } catch (e: any) {
      showError('Could not create session', e);
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

  // Per-row commit, keyed by id: a Set rather than a boolean because two settled
  // sessions can be committing at once, and each row only cares about its own.
  const [committing, setCommitting] = useState<Set<string>>(new Set());
  const commit = async (s: Session) => {
    if (!conn || committing.has(s.id)) return;
    setCommitting((prev) => new Set(prev).add(s.id));
    try {
      const r = await conn.req<{ ok: boolean; stderr?: string }>('commit-session', s.id);
      if (!r?.ok) showError('Commit failed', r?.stderr || 'Commit failed');
      // Main marks the session 'pushed' and pushes sessions-changed; refresh so the
      // diff pill collapses to "pushed" without waiting for the next poll tick.
      else refresh();
    } catch (e: any) {
      showError('Commit failed', e);
    } finally {
      setCommitting((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    }
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

  // The All tab mixes live and archived sessions, so its useful split is that one —
  // Active over Archived, under the same category labels the state grouping uses. The
  // other tabs are already scoped to one of those, so they group by state instead.
  const sections = useMemo(() => {
    const groups = tab === 'all'
      ? [
        { key: 'active', label: 'Active', hue: color.green, is: (s: Session) => !s.archived },
        { key: 'archived', label: 'Archived', hue: color.muted, is: () => true },
      ]
      : GROUPS;
    return groups.map((g, i) => ({
      ...g,
      // Each session falls into the FIRST group that claims it, so the catch-all
      // (`settled` / `archived`) can't swallow an earlier group's row.
      data: items.filter((s) => groups.findIndex((x) => x.is(s)) === i),
    })).filter((g) => g.data.length > 0);
  }, [items, tab]);

  const emptyText = useMemo(() => {
    if (!repo) return 'Open a project first.';
    if (tab === 'archived') {
      return query ? `No archived sessions match “${query}”.` : 'No archived sessions.';
    }
    return 'No sessions yet — tap New session.';
  }, [repo, tab, query]);

  const actions = (s: Session) => (s.archived ? (
    <>
      <IconButton icon="arrow-up-circle-outline" label="Restore" onPress={() => unarchive(s)} />
      <IconButton icon="trash-outline" label="Delete" hue={color.fileRed} onPress={() => remove(s)} />
    </>
  ) : (
    <>
      {/* Icon-only, like the row's other actions: a done session with work left in
          the tree gets a one-tap commit. Sessions with nothing to commit (or already
          pushed) simply don't grow the button, mirroring the desktop's disabled state. */}
      {s.state === 'completed' && (s.added > 0 || s.removed > 0) && (
        committing.has(s.id) ? (
          <ActivityIndicator size="small" color={color.green} style={styles.commitSpin} />
        ) : (
          <IconButton
            icon="git-commit-outline"
            label="Commit changes"
            hue={color.green}
            onPress={() => commit(s)}
          />
        )
      )}
      <IconButton icon="archive-outline" label="Archive" onPress={() => archive(s)} />
    </>
  ));

  return (
    <View style={styles.fill}>
      <ScreenHeader title="Sessions">
        <View style={styles.segments}>
          {TABS.map((t) => {
            const on = t.key === tab;
            return (
              <Pressable
                key={t.key}
                style={[styles.segment, on && styles.segmentOn]}
                onPress={() => selectTab(t.key)}
              >
                <Text style={[styles.segmentLabel, on && styles.segmentLabelOn]}>
                  {t.label} <Text style={styles.segmentCount}>{counts[t.key]}</Text>
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'archived' && (
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={color.faint} />
            <TextInput
              style={styles.search}
              value={search}
              onChangeText={setSearch}
              placeholder="Search archived sessions"
              placeholderTextColor={color.faint}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={16} color={color.faint} />
              </Pressable>
            )}
          </View>
        )}
      </ScreenHeader>

      <SectionList
        sections={sections}
        keyExtractor={(s) => s.id}
        refreshing={false}
        onRefresh={refresh}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={sections.length ? styles.list : styles.fill}
        renderSectionHeader={({ section }) => (
          <CategoryLabel
            label={section.label}
            hue={section.hue}
            count={section.data.length}
            style={styles.sectionHeader}
          />
        )}
        renderItem={({ item, section }) => (
          <SessionRow
            session={item}
            // On the All tab the sections split by archived-ness, but a row still
            // dresses by its state — a working session keeps its breathing card even
            // while filed under Active.
            group={tab === 'all' ? GROUPS.find((g) => g.is(item))!.key : section.key}
            justFinished={justFinished.has(item.id)}
            onPress={() => open(item)}
            actions={actions(item)}
          />
        )}
        ListEmptyComponent={<Text style={styles.empty}>{emptyText}</Text>}
        ListFooterComponent={
          loadingMore ? <ActivityIndicator style={styles.more} color={color.muted} /> : null
        }
      />

      {/* The split button: the wide half creates with the remembered model, the caret
          half opens the picker — the desktop's #new-session / caret pair, and the
          shape this app has always used. Docked rather than a floating FAB, and a
          pill rather than a rounded rectangle, so it reads as one control. */}
      <View style={styles.newWrap}>
        <Pressable
          style={({ pressed }) => [
            styles.new, styles.newMain, !repo && styles.newOff, pressed && repo && styles.newPressed,
          ]}
          onPress={() => newSession()}
          disabled={!repo}
        >
          <Ionicons name="add" size={20} color={repo ? '#fff' : color.muted} />
          <Text style={[styles.newLabel, !repo && styles.newLabelOff]} numberOfLines={1}>
            New session
          </Text>
          {/* The model rides behind a divider rather than in the label, so the
              button says the same thing at every width. */}
          {modelSuffix(model) !== '' && (
            <Text style={[styles.newModel, !repo && styles.newLabelOff]} numberOfLines={1}>
              {modelBadgeName(model)}
            </Text>
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.new, styles.newCaret, !repo && styles.newOff, pressed && repo && styles.newPressed,
          ]}
          onPress={openMenu}
          disabled={!repo}
          accessibilityLabel="Choose model"
        >
          <Ionicons name="chevron-up" size={18} color={repo ? '#fff' : color.muted} />
        </Pressable>
      </View>

      {/* statusBarTranslucent so the backdrop dims the status bar too — without it,
          Android's modal window starts below the bar and leaves an undimmed strip
          across the top (see mobile-design.md, "Darkening the screen"). No top shift
          is needed here: unlike UsagePanel, the menu is anchored from the bottom. */}
      <Modal visible={menuOpen} transparent statusBarTranslucent animationType="none" onRequestClose={() => closeMenu()}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable style={styles.fill} onPress={() => closeMenu()} />
          <Animated.View
            style={[styles.menu, { marginBottom: menuLift }, menuStyle]}
            onLayout={(e) => setMenuHeight(e.nativeEvent.layout.height)}
          >
            <Text style={styles.menuHeading}>New session with</Text>
            {MODELS.filter((m) => m.id !== DEFAULT_MODEL).map((m) => (
              <MenuItem key={m.id} label={m.name} on={m.id === model} onPress={() => closeMenu(() => newSession(m.id))} />
            ))}
            {ollamaModels.length > 0 && <View style={styles.menuDivider} />}
            {ollamaModels.map((m) => (
              <MenuItem
                key={m.id}
                label={m.name}
                icon="hardware-chip-outline"
                on={m.id === model}
                onPress={() => closeMenu(() => newSession(m.id))}
              />
            ))}
          </Animated.View>
        </Animated.View>
      </Modal>
    </View>
  );
}

// One session, drawn as what it's doing. A working session gets the tool line and the
// orbiting edge; a settled one collapses to a row, because a card each would give a
// finished session the same weight as one that wants an answer.
function SessionRow(
  { session: s, group, justFinished, onPress, actions }:
  {
    session: Session; group: string; justFinished: boolean;
    onPress: () => void; actions: React.ReactNode;
  },
) {
  const time = shortAgo(s.lastActiveAt || s.startedAt);

  if (group === 'settled') {
    return (
      <FinishFlash on={justFinished}>
        <Pressable
          style={({ pressed }) => [styles.settled, pressed && styles.rowPressed]}
          onPress={onPress}
        >
          <StateDot state={s.state} size={8} celebrate={justFinished} />
          <Text style={[styles.settledName, s.archived && styles.nameArchived]} numberOfLines={1}>
            {title(s)}
          </Text>
          <DiffPill added={s.added} removed={s.removed} state={s.state} />
          {actions}
        </Pressable>
      </FinishFlash>
    );
  }

  // A working card's hue laps its edge; a needs-you card holds a steady green. Both are
  // lit, but only one is still moving — which is the distinction the eye needs when
  // scanning the list.
  const needs = group === 'needs';
  return (
    <Card hue={needs ? color.green : color.yellow} orbit={!needs} style={styles.card}>
      <Pressable
        style={({ pressed }) => [styles.cardBody, pressed && styles.rowPressed]}
        onPress={onPress}
      >
        {/* The actions sit outside the text column rather than on the title row, so the
            archive button centres against the card's full height instead of riding the
            first line of a two-line card. */}
        <View style={styles.cardMain}>
          <View style={styles.cardTop}>
            <StateDot state={s.state} size={needs ? 8 : 10} />
            <Text style={styles.cardTitle} numberOfLines={1}>{title(s)}</Text>
          </View>
          {/* The time rides the status line itself, after the model name and behind the
              same separator — one phrase in one ink, rather than a differently-coloured
              stamp floating at the row's far edge. */}
          {needs ? (
            <Text style={styles.waiting} numberOfLines={1}>
              {['Waiting for you', s.model ? modelBadgeName(s.model) : null, time || null]
                .filter(Boolean).join(' · ')}
            </Text>
          ) : (
            <Text style={styles.toolLine} numberOfLines={1}>{toolLine(s, time)}</Text>
          )}
        </View>
        {actions}
      </Pressable>
    </Card>
  );
}

// The desktop's `sess-finish-flash`: a green wash over the row that fades out, to pull
// the eye back to a run that landed while you were looking elsewhere.
//
// The wash is a sibling drawn *before* the row rather than a background colour on it —
// RN stacks absolute children in document order, so this stays behind the text, and an
// opacity fade runs on the native driver where an animated backgroundColor could not.
function FinishFlash({ on, children }: { on: boolean; children: React.ReactNode }) {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!on) return;
    t.setValue(1);
    Animated.timing(t, {
      toValue: 0,
      duration: motion.flash,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [on, t]);

  return (
    <View>
      <Animated.View pointerEvents="none" style={[styles.flash, { opacity: t }]} />
      {children}
    </View>
  );
}

// What a working session is doing, as the design's mono line: the tool, the file
// it's pointed at, and the model. Main sends no tool for a session between calls,
// which reads as the model alone rather than as a lie about what's running.
function toolLine(s: Session, time: string): string {
  return [s.tool?.name, s.tool?.file, s.model ? modelBadgeName(s.model) : null, time || null]
    .filter(Boolean)
    .join(' · ');
}

// The work a settled session left behind. A pushed session says so instead — its
// lines are already in the history, so the count is no longer the news.
function DiffPill({ added, removed, state }: { added: number; removed: number; state: string }) {
  if (state === 'pushed') return <Text style={type.time}>pushed</Text>;
  if (!added && !removed) return null;
  return <Pill label={`+${added} −${removed}`} hue={color.green} />;
}

function MenuItem(
  { label, on, icon, onPress }:
  { label: string; on: boolean; icon?: any; onPress: () => void },
) {
  return (
    <Pressable style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed, on && styles.menuItemOn]} onPress={onPress}>
      {icon && <Ionicons name={icon} size={14} color={color.muted} />}
      <Text style={[styles.menuLabel, on && styles.menuLabelOn]}>{label}</Text>
      {on && <Ionicons name="checkmark" size={15} color={color.accent} />}
    </Pressable>
  );
}

function title(s: Session) {
  return s.name || s.firstPrompt || 'Unnamed session';
}

const styles = StyleSheet.create({
  // The page colour is spelled out because the navigator's DarkTheme would otherwise
  // show through — its background is rgb(1,1,1), a black that belongs to no token and
  // reads as a hole next to #0d1117.
  fill: { flex: 1, backgroundColor: color.bg },
  list: { padding: 16, paddingBottom: 8, gap: 8 },

  segments: {
    flexDirection: 'row', backgroundColor: color.bg, borderRadius: 9, padding: 2, marginBottom: 12,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 7 },
  segmentOn: { backgroundColor: color.raisedHi, ...shadow.thumb },
  segmentLabel: { color: color.muted, fontSize: 13, fontWeight: '600' },
  segmentLabelOn: { color: color.text },
  segmentCount: { fontWeight: '500', color: color.muted },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 12, paddingHorizontal: 10,
    borderRadius: radius.md, backgroundColor: color.bg,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
  },
  search: { flex: 1, paddingVertical: 8, color: color.text, fontSize: 14 },

  sectionHeader: { paddingTop: 6, paddingBottom: 2 },

  card: {},
  cardBody: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 14,
  },
  cardMain: { flex: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { ...type.cardTitle, flex: 1 },
  waiting: { color: color.green, fontSize: 12, marginTop: 4, paddingLeft: 18 },
  toolLine: { color: color.muted, fontSize: 12, fontFamily: font.mono, marginTop: 4, paddingLeft: 18 },

  // Desktop's flash starts at 34% green; the phone's row has no card behind it, so the
  // wash is inset to a rounded band rather than bleeding to the screen edge.
  flash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: tint.flash(color.green),
    borderRadius: radius.md,
    marginHorizontal: -4,
  },

  settled: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 4 },
  settledName: { flex: 1, color: color.text, fontSize: 14 },
  nameArchived: { color: color.muted },
  rowPressed: { opacity: 0.6 },

  // Same footprint as the IconButton it replaces, so the row doesn't shift mid-commit.
  commitSpin: { width: 31, height: 31 },

  empty: { color: color.muted, textAlign: 'center', marginTop: 48, paddingHorizontal: 24 },
  more: { paddingVertical: 16 },

  newWrap: {
    flexDirection: 'row', gap: 2,
    marginHorizontal: 16, marginTop: 8, marginBottom: 12,
  },
  new: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, backgroundColor: color.greenDeep,
  },
  newMain: { flex: 1, borderTopLeftRadius: radius.pill, borderBottomLeftRadius: radius.pill },
  newCaret: { paddingHorizontal: 18, borderTopRightRadius: radius.pill, borderBottomRightRadius: radius.pill },
  newPressed: { backgroundColor: '#2ea043' },
  newOff: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  newLabel: { color: '#fff', fontSize: font.size.md, fontWeight: '600' },
  newLabelOff: { color: color.muted },
  newModel: {
    color: 'rgba(255, 255, 255, 0.55)', fontSize: 13,
    borderLeftWidth: 1, borderLeftColor: 'rgba(255, 255, 255, 0.25)', paddingLeft: 8,
  },

  // The tap-to-dismiss area fills everything above the menu, so the menu itself
  // sits just above the button it grew out of.
  backdrop: { flex: 1, backgroundColor: '#00000080' },
  menu: {
    marginHorizontal: 16,
    borderRadius: 12, padding: 5,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
    ...shadow.menu,
  },
  menuHeading: { ...type.fieldLabel, paddingHorizontal: 10, paddingTop: 5, paddingBottom: 6 },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8,
  },
  menuItemPressed: { backgroundColor: color.raised },
  menuItemOn: { backgroundColor: tint.fill(color.accentDim) },
  menuLabel: { flex: 1, color: color.text, fontSize: 14 },
  menuLabelOn: { color: color.accent, fontWeight: '600' },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderSoft, marginHorizontal: 8, marginVertical: 3 },
});
