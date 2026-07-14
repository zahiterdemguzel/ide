// Dev-server port forwarding: type the port your dev server runs on (e.g. 3000
// for a web app on the desktop) and open it in the phone's browser through the
// desktop's LAN proxy. The URL carries a one-time auth token.
import React, { useState } from 'react';
import { View, Text, TextInput, Button, FlatList, Pressable, Alert, StyleSheet, Linking } from 'react-native';
import { useConnection } from '../api/context';

type Fwd = { port: number; url: string };

export default function PortsScreen() {
  const { conn } = useConnection();
  const [portText, setPortText] = useState('3000');
  const [forwards, setForwards] = useState<Fwd[]>([]);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return Alert.alert('Ports', 'Enter a valid port.');
    setBusy(true);
    try {
      const url = await conn!.forwardPort(port);
      setForwards((prev) => [{ port, url }, ...prev.filter((f) => f.port !== port)]);
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert('Ports', String(e?.message ?? e));
    }
    setBusy(false);
  };

  const stop = (f: Fwd) => {
    conn?.closeForward(f.port);
    setForwards((prev) => prev.filter((x) => x.port !== f.port));
  };

  return (
    <View style={styles.fill}>
      <Text style={styles.hint}>
        Forward a dev server running on the desktop (e.g. localhost:3000) and test it in this phone's browser.
      </Text>
      <View style={styles.rowInput}>
        <TextInput
          style={styles.input}
          value={portText}
          onChangeText={setPortText}
          keyboardType="number-pad"
          placeholder="3000"
          placeholderTextColor="#777"
        />
        <Button title="Open in browser" disabled={busy} onPress={open} />
      </View>
      <FlatList
        data={forwards}
        keyExtractor={(f) => String(f.port)}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable style={styles.grow} onPress={() => Linking.openURL(item.url)}>
              <Text style={styles.port}>localhost:{item.port}</Text>
              <Text style={styles.url} numberOfLines={1}>{item.url}</Text>
            </Pressable>
            <Button title="Stop" onPress={() => stop(item)} />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hint: { color: '#888', padding: 12 },
  rowInput: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, alignItems: 'center' },
  input: { flex: 1, color: '#fff', backgroundColor: '#2a2a2a', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  grow: { flex: 1 },
  port: { color: '#fff', fontSize: 15 },
  url: { color: '#61afef', fontSize: 12 },
});
