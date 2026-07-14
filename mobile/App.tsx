// IDE Remote — companion app. Pairs with the desktop IDE by scanning the QR
// code in its Settings dialog, then drives it over the ws protocol (projects,
// Claude sessions, git, files, forwarded ports).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Connection, ConnectionState } from './src/api/connection';
import { loadCredentials, saveCredentials, clearCredentials, wsUrl, PairInfo } from './src/api/pairing';
import { ConnectionContext, useConnection } from './src/api/context';
import ProjectDrawer, { basename } from './src/components/ProjectDrawer';
import PairScreen from './src/screens/PairScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import SessionTerminal from './src/screens/SessionTerminal';
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

function ProjectButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.projectBtn, pressed && styles.projectBtnPressed]}
      hitSlop={10}
      onPress={onPress}
    >
      <Ionicons name="folder-open-outline" size={18} color="#4da3ff" />
    </Pressable>
  );
}

// Main hub after pairing: iOS/Android-style bottom tab bar.
function MainTabs() {
  const { conn, state } = useConnection();
  const [drawerOpen, setDrawerOpen] = useState(false);
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
          headerStyle: { backgroundColor: '#161b22' },
          headerTitleAlign: 'center',
          headerShadowVisible: false,
          headerTitle: () => <ProjectTitle name={current} />,
          headerLeft: () => <ProjectButton onPress={() => setDrawerOpen(true)} />,
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
    </>
  );
}

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [state, setState] = useState<ConnectionState>('closed');

  // Reconnect with the stored credential on launch; fall back to the pair screen.
  useEffect(() => {
    (async () => {
      const creds = await loadCredentials();
      if (!creds) return;
      const c = new Connection(creds.url, { deviceToken: creds.deviceToken });
      c.onState(setState);
      c.connect();
      setConn(c);
    })();
  }, []);

  const pair = useCallback((info: PairInfo) => {
    const url = wsUrl(info.host, info.port);
    const c = new Connection(url, { pairToken: info.pairToken, deviceName: 'IDE Remote' },
      (deviceToken) => { saveCredentials(url, deviceToken); });
    c.onState(setState);
    c.connect();
    setConn(c);
  }, []);

  const unpair = useCallback(async () => {
    conn?.close();
    await clearCredentials();
    setConn(null);
    setState('closed');
  }, [conn]);

  const ctx = useMemo(() => ({ conn, state, pair, unpair }), [conn, state, pair, unpair]);
  const paired = conn && state !== 'error';

  return (
    <ConnectionContext.Provider value={ctx}>
      <NavigationContainer theme={DarkTheme}>
        <StatusBar style="light" />
        <Stack.Navigator>
          {!paired ? (
            <Stack.Screen name="Pair" component={PairScreen} options={{ title: 'Pair with desktop' }} />
          ) : (
            <>
              <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
              <Stack.Screen name="Terminal" component={SessionTerminal} options={{ headerShown: false }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </ConnectionContext.Provider>
  );
}

const styles = StyleSheet.create({
  projectBtn: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    borderRadius: 8,
    backgroundColor: '#21262d',
  },
  projectBtnPressed: { backgroundColor: '#30363d' },
  projectName: { color: '#e6edf3', fontSize: 15, fontWeight: '600', maxWidth: 200 },
});
