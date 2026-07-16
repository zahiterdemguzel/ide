// IDE Remote — companion app. Pairs with the desktop IDE by scanning the QR
// code in its Settings dialog, then drives it over the ws protocol (projects,
// Claude sessions, git, files, forwarded ports).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavigationContainer, DarkTheme, useIsFocused, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppState, StyleSheet, View } from 'react-native';
import { color, TAB_BAR_HEIGHT } from './src/theme';
import { Connection, ConnectionState } from './src/api/connection';
import { loadCredentials, saveCredentials, clearCredentials, Endpoints, PairInfo } from './src/api/pairing';
import { Instance, instanceEndpoints } from './src/api/instances';
import { ConnectionContext, useConnection } from './src/api/context';
import ProjectDrawer from './src/components/ProjectDrawer';
import RunDrawer from './src/components/RunDrawer';
import { ChromeContext } from './src/components/ScreenHeader';
import ErrorDialog from './src/components/ErrorDialog';
import { AlertFeed } from './src/api/notifications';
import { registerPush, onNotificationTap } from './src/api/push';
import WelcomeScreen from './src/screens/WelcomeScreen';
import PairScreen from './src/screens/PairScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import ChatScreen from './src/screens/ChatScreen';
import ConsoleTerminal from './src/screens/ConsoleTerminal';
import GitScreen from './src/screens/GitScreen';
import FilesScreen from './src/screens/FilesScreen';
import PortsScreen from './src/screens/PortsScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

// A ref, not the hook: a notification tap arrives outside any screen (App level),
// and may arrive before the navigator exists (cold start from the notification).
const navRef = createNavigationContainerRef();

// React Navigation's own DarkTheme paints rgb(1,1,1) behind every screen — a black
// that belongs to no token and reads as a hole beside the page's #0d1117. It shows
// wherever a screen doesn't paint its own background, which is easy to miss and was
// the actual cause of two "why is this black?" bugs. Fix it once, at the source, so
// a new screen can't inherit it.
const NAV_THEME = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: color.bg },
};

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Sessions: 'chatbubbles-outline',
  Git: 'git-branch-outline',
  Files: 'document-text-outline',
  Ports: 'globe-outline',
};

// Main hub after pairing: iOS/Android-style bottom tab bar.
//
// The navigator's header is off: each screen draws its own (ScreenHeader), because
// the design puts a large title under the project row and a stock header has no
// room for it. The drawers stay here — one of each for the whole hub — and the
// screens open them through ChromeContext.
function MainTabs() {
  const { conn, state } = useConnection();
  const insets = useSafeAreaInsets();
  // Whether the Main hub itself is the focused stack screen. The drawers are
  // Modals, which float above *pushed* screens too — so while a terminal opened
  // from the Run panel has focus we hide the modal but keep its open state,
  // and backing out of the terminal lands on the panel again.
  const isFocused = useIsFocused();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (conn && state === 'ready') {
      conn.req('get-repo-path').then((p) => setCurrent(p as string | null)).catch(() => {});
    }
    return conn?.on('folder-changed', ({ repo }: any) => setCurrent(repo));
  }, [conn, state]);

  const chrome = useMemo(
    () => ({ project: current, openProjects: () => setDrawerOpen(true), openRun: () => setRunOpen(true) }),
    [current],
  );

  return (
    <ChromeContext.Provider value={chrome}>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          // The bar reserves exactly the gesture inset the device reports — never a
          // constant. On Android that's 0 (the system's own bar sits below our
          // window and is painted to match via `androidNavigationBar` in app.json),
          // so a hardcoded iPhone 40 here left a dead strip above a black one.
          tabBarStyle: {
            backgroundColor: color.surface,
            borderTopColor: color.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            height: TAB_BAR_HEIGHT + insets.bottom,
            paddingTop: 8,
            paddingBottom: insets.bottom,
          },
          tabBarActiveTintColor: color.accent,
          tabBarInactiveTintColor: color.muted,
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          // The active tab's icon sits in a tinted pill — the one place the tab bar
          // says which screen you're on beyond the label's colour.
          tabBarIcon: ({ color: tint, focused }) => (
            <View style={[styles.tabIcon, focused && styles.tabIconOn]}>
              <Ionicons
                name={focused ? (TAB_ICONS[route.name].replace('-outline', '') as any) : TAB_ICONS[route.name]}
                size={21}
                color={tint}
              />
            </View>
          ),
        })}
      >
        <Tab.Screen name="Sessions" component={SessionsScreen} />
        <Tab.Screen name="Git" component={GitScreen} />
        <Tab.Screen name="Files" component={FilesScreen} />
        <Tab.Screen name="Ports" component={PortsScreen} />
      </Tab.Navigator>
      <ProjectDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <RunDrawer visible={runOpen && isFocused} onClose={() => setRunOpen(false)} />
    </ChromeContext.Provider>
  );
}

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [state, setState] = useState<ConnectionState>('closed');
  // The pairing endpoints, kept after launch because choosing a *window* re-dials:
  // each is named separately inside the room by its instance id.
  const [creds, setCreds] = useState<{ endpoints: Endpoints; deviceToken: string } | null>(null);
  const [instances, setInstances] = useState<Instance[] | null>(null); // non-null only while choosing
  const [instance, setInstance] = useState<Instance | null>(null);
  const [chosen, setChosen] = useState(false); // distinct from `instance`: an old desktop names no window

  // The replaced connection's socket dies *after* the new one is dialled, and its
  // late 'closed' must not stomp the new connection's 'ready' — so only the current
  // connection may feed `state`. Detach the old listener before dialling.
  const stateUnsub = useRef<(() => void) | null>(null);
  // The live connection, tracked in a ref so `open` (which has no deps) can tear down
  // the previous one. A Connection reconnects itself forever until `close()`d, so
  // replacing one without closing it leaks a socket that keeps re-dialling the relay.
  const connRef = useRef<Connection | null>(null);

  const open = useCallback((endpoints: Endpoints, auth: ConstructorParameters<typeof Connection>[1],
    onDeviceToken?: (t: string) => void) => {
    if (!endpoints.relay) return;
    stateUnsub.current?.();
    connRef.current?.close();
    const c = new Connection(endpoints.relay, auth, onDeviceToken, () => { clearCredentials(); });
    connRef.current = c;
    stateUnsub.current = c.onState(setState);
    c.connect();
    setConn(c);
  }, []);

  // Persistency without battery drain: no background keepalive — the OS freezes JS in
  // background and the relay reaps the silent socket anyway. Instead the socket is
  // dropped on purpose when the app backgrounds and re-dialled the moment it is
  // foregrounded, so coming back is one instant reconnect instead of minutes of a
  // half-open socket timing out every request.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      const c = connRef.current;
      if (!c) return;
      if (s === 'active') c.resume();
      else if (s === 'background') c.suspend();
    });
    return () => sub.remove();
  }, []);

  // Push notifications: once a connection is driving a window, hand the desktop
  // this device's Expo push token so completed sessions notify the phone while the
  // app is closed. Re-sent on every `ready` — cheap, and the desktop skips the
  // write when nothing changed.
  useEffect(() => {
    if (conn && state === 'ready') registerPush(conn);
  }, [conn, state]);

  // A tapped notification names a session; hold it until the app is actually
  // driving a window (cold start pairs + connects first), then open its chat.
  const [pendingSession, setPendingSession] = useState<string | null>(null);
  const [navReady, setNavReady] = useState(false);
  useEffect(() => onNotificationTap((tap) => setPendingSession(tap.sessionId)), []);
  useEffect(() => {
    if (!pendingSession || !chosen || state !== 'ready' || !navReady) return;
    setPendingSession(null);
    (navRef.navigate as unknown as (name: string, params?: object) => void)('Chat', { id: pendingSession });
  }, [pendingSession, chosen, state, navReady]);

  // Reconnect with the stored credential on launch; fall back to the pair screen.
  useEffect(() => {
    (async () => {
      const stored = await loadCredentials();
      if (!stored) return;
      setCreds(stored);
      open(stored.endpoints, { deviceToken: stored.deviceToken });
    })();
  }, [open]);

  // Connected — but to *a* window, whichever one answered, and the machine may be
  // running several. Ask which; the one we reached answers for its siblings too.
  // The roster is never cached: an instance id lasts only as long as its process.
  useEffect(() => {
    // Bail if the chooser is already open (`instances` non-null): switchInstance opens
    // it and flips `chosen` false, and without this guard that flip re-fires this effect
    // — a duplicate list-instances, and if a window closed meanwhile so the list is now
    // ≤1, it auto-selects and closes the chooser the user just opened.
    if (!conn || state !== 'ready' || chosen || instances) return;
    let dropped = false;
    conn.req<Instance[]>('list-instances')
      .then((list) => {
        if (dropped) return;
        // Nothing to choose between: go straight in, exactly as before windows were
        // selectable. (An empty list means the desktop is too old to know the channel.)
        if (list.length > 1) return setInstances(list);
        setInstance(list[0] ?? null);
        setChosen(true);
      })
      .catch(() => { if (!dropped) setChosen(true); });
    return () => { dropped = true; };
  }, [conn, state, chosen, instances]);

  const pair = useCallback((info: PairInfo) => {
    const endpoints = { relay: info.relay };
    open(endpoints, { pairToken: info.pairToken, deviceName: 'IDE Remote' }, (deviceToken) => {
      saveCredentials(endpoints, deviceToken);
      setCreds({ endpoints, deviceToken });
    });
  }, [open]);

  const selectInstance = useCallback((inst: Instance) => {
    setInstance(inst);
    setInstances(null);
    setChosen(true);
    // The window that served the roster is the one we are already on — no reconnect.
    if (inst.current || !creds) return;
    conn?.close();
    open(instanceEndpoints(creds.endpoints, inst), { deviceToken: creds.deviceToken });
  }, [conn, creds, open]);

  // Re-list rather than reuse what we fetched at launch: windows open and close, and
  // the one the user wants may be newer than this session.
  const switchInstance = useCallback(async () => {
    if (!conn || state !== 'ready') return;
    const list = await conn.req<Instance[]>('list-instances').catch(() => [] as Instance[]);
    if (!list.length) return;
    setInstances(list);
    setChosen(false);
  }, [conn, state]);

  const unpair = useCallback(async () => {
    stateUnsub.current?.();
    stateUnsub.current = null;
    connRef.current?.close();
    connRef.current = null;
    await clearCredentials();
    setConn(null);
    setState('closed');
    setCreds(null);
    setInstances(null);
    setInstance(null);
    setChosen(false);
  }, [conn]);

  const ctx = useMemo(
    () => ({ conn, state, pair, unpair, instances, instance, selectInstance, switchInstance }),
    [conn, state, pair, unpair, instances, instance, selectInstance, switchInstance],
  );
  const paired = conn && state !== 'error';

  return (
    <ConnectionContext.Provider value={ctx}>
      {/* Turns connection pushes into notification alerts, regardless of screen. */}
      <AlertFeed />
      <SafeAreaProvider>
        <NavigationContainer theme={NAV_THEME} ref={navRef} onReady={() => setNavReady(true)}>
          <StatusBar style="light" />
          {/* contentStyle paints the *native* screen container. The nav theme only
              covers what React renders; during a push/pop the native container is
              briefly visible on its own, and its default is white — one white frame
              on every open and close until it's painted here. */}
          <Stack.Navigator screenOptions={{ contentStyle: { backgroundColor: color.bg } }}>
            {!paired ? (
              <>
                <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Pair" component={PairScreen} options={{ title: 'Scan QR code' }} />
              </>
            ) : !chosen ? (
              // Paired, but not driving a window yet: connecting, or picking one of
              // several. Welcome is both — and dropping the Pair route here is what
              // takes the camera off the screen the moment a scan lands.
              <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ headerShown: false }} />
            ) : (
              <>
                <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
                {/* A Claude session is a conversation, not a terminal — the phone
                    renders it as a chat. The one terminal left is the run console
                    (a dev server's log), which is a terminal by nature. */}
                <Stack.Screen name="Chat" component={ChatScreen} options={{ headerShown: false }} />
                <Stack.Screen name="Console" component={ConsoleTerminal} options={{ headerShown: false }} />
                {/* Pushed from the bell in any tab's header, not a tab of its own:
                    it's a log you visit, not a place you work. */}
                <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ headerShown: false }} />
              </>
            )}
          </Stack.Navigator>
        </NavigationContainer>
        {/* Sits above navigation so any error, on any screen, surfaces here. */}
        <ErrorDialog />
      </SafeAreaProvider>
    </ConnectionContext.Provider>
  );
}

const styles = StyleSheet.create({
  tabIcon: { paddingHorizontal: 16, paddingVertical: 3, borderRadius: 999 },
  tabIconOn: { backgroundColor: 'rgba(31, 111, 235, 0.18)' },
});
