// IDE Remote — companion app. Pairs with the desktop IDE by scanning the QR
// code in its Settings dialog, then drives it over the ws protocol (projects,
// Claude sessions, git, files, forwarded ports).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Connection, ConnectionState } from './src/api/connection';
import { loadCredentials, saveCredentials, clearCredentials, wsUrl, PairInfo } from './src/api/pairing';
import { ConnectionContext } from './src/api/context';
import PairScreen from './src/screens/PairScreen';
import ProjectsScreen from './src/screens/ProjectsScreen';
import SessionsScreen from './src/screens/SessionsScreen';
import SessionTerminal from './src/screens/SessionTerminal';
import GitScreen from './src/screens/GitScreen';
import FilesScreen from './src/screens/FilesScreen';
import PortsScreen from './src/screens/PortsScreen';

const Stack = createNativeStackNavigator();

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
              <Stack.Screen name="Projects" component={ProjectsScreen} />
              <Stack.Screen name="Sessions" component={SessionsScreen} />
              <Stack.Screen name="Terminal" component={SessionTerminal} options={{ headerShown: false }} />
              <Stack.Screen name="Git" component={GitScreen} />
              <Stack.Screen name="Files" component={FilesScreen} />
              <Stack.Screen name="Ports" component={PortsScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </ConnectionContext.Provider>
  );
}
