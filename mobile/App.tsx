// IDE Remote — companion app. Pairs with the desktop IDE by scanning the QR
// code in its Settings dialog, then drives it over the ws protocol (projects,
// Claude sessions, git, files, forwarded ports).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Connection, ConnectionState } from './src/api/connection';
import { loadCredentials, saveCredentials, clearCredentials, Endpoints, PairInfo } from './src/api/pairing';
import { Instance, instanceEndpoints } from './src/api/instances';
import { ConnectionContext, useConnection } from './src/api/context';
import ProjectDrawer, { basename } from './src/components/ProjectDrawer';
import RunDrawer from './src/components/RunDrawer';
import UsageBar from './src/components/UsageBar';
import WelcomeScreen from './src/screens/WelcomeScreen';
import PairScreen from './src/screens/PairScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import ChatScreen from './src/screens/ChatScreen';
import ConsoleTerminal from './src/screens/ConsoleTerminal';
import GitScreen from './src/screens/GitScreen';
import FilesScreen from './src/screens/FilesScreen';
import PortsScreen from './src/screens/PortsScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Sessions: 'chatbubbles-outline',
  Git: 'git-branch-outline',
  Files: 'document-text-outline',
  Ports: 'globe-outline',
};

// The tab bar already names the current screen, so the header title says which
// project you're driving instead. The switcher itself is a side action: a small
// icon-only button that opens ProjectDrawer, not a tab of its own.
function ProjectTitle({ name }: { name: string | null }) {
  return (
    <Text style={styles.projectName} numberOfLines={1}>
      {name ? basename(name) : 'Select project'}
    </Text>
  );
}

// The two side actions bracket the header: project switcher on the left, the run
// panel (launch configs, tasks, and the terminals they opened) on the right.
function HeaderButton({ icon, color, onPress }: { icon: any; color: string; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.headerBtn, pressed && styles.headerBtnPressed]}
      hitSlop={10}
      onPress={onPress}
    >
      <Ionicons name={icon} size={18} color={color} />
    </Pressable>
  );
}

// Main hub after pairing: iOS/Android-style bottom tab bar.
function MainTabs() {
  const { conn, state } = useConnection();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (conn && state === 'ready') {
      conn.req('get-repo-path').then((p) => setCurrent(p as string | null)).catch(() => {});
    }
    return conn?.on('folder-changed', ({ repo }: any) => setCurrent(repo));
  }, [conn, state]);

  return (
    <>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerTitleAlign: 'center',
          headerShadowVisible: false,
          // The usage line rides the bottom edge of the header on every tab, so it
          // is painted with the header background rather than added to each screen.
          headerBackground: () => (
            <View style={styles.header}>
              <UsageBar />
            </View>
          ),
          headerTitle: () => <ProjectTitle name={current} />,
          headerLeft: () => (
            <HeaderButton icon="folder-open-outline" color="#4da3ff" onPress={() => setDrawerOpen(true)} />
          ),
          headerRight: () => (
            <HeaderButton icon="play" color="#3fb950" onPress={() => setRunOpen(true)} />
          ),
          tabBarStyle: {
            backgroundColor: '#161b22',
            borderTopColor: '#30363d',
            borderTopWidth: StyleSheet.hairlineWidth,
            height: 62,
            paddingTop: 6,
            paddingBottom: 8,
          },
          tabBarActiveTintColor: '#4da3ff',
          tabBarInactiveTintColor: '#7d8590',
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name={focused ? (TAB_ICONS[route.name].replace('-outline', '') as any) : TAB_ICONS[route.name]}
              size={size - 2}
              color={color}
            />
          ),
        })}
      >
        <Tab.Screen name="Sessions" component={SessionsScreen} />
        <Tab.Screen name="Git" component={GitScreen} />
        <Tab.Screen name="Files" component={FilesScreen} />
        <Tab.Screen name="Ports" component={PortsScreen} />
      </Tab.Navigator>
      <ProjectDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <RunDrawer visible={runOpen} onClose={() => setRunOpen(false)} />
    </>
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

  const open = useCallback((endpoints: Endpoints, auth: ConstructorParameters<typeof Connection>[1],
    onDeviceToken?: (t: string) => void) => {
    if (!endpoints.relay) return;
    stateUnsub.current?.();
    const c = new Connection(endpoints.relay, auth, onDeviceToken);
    stateUnsub.current = c.onState(setState);
    c.connect();
    setConn(c);
  }, []);

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
    if (!conn || state !== 'ready' || chosen) return;
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
  }, [conn, state, chosen]);

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
    conn?.close();
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
      <SafeAreaProvider>
        <NavigationContainer theme={DarkTheme}>
          <StatusBar style="light" />
          <Stack.Navigator>
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
              </>
            )}
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </ConnectionContext.Provider>
  );
}

const styles = StyleSheet.create({
  header: { flex: 1, backgroundColor: '#161b22' },
  headerBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#21262d',
  },
  headerBtnPressed: { backgroundColor: '#30363d' },
  projectName: { color: '#e6edf3', fontSize: 15, fontWeight: '600', maxWidth: 160 },
});
