// Dev-server port forwarding: type the port your dev server runs on (e.g. 3000
// for a web app on the desktop) and open it in the phone's browser through the
// desktop's proxy. The URL carries a one-time auth token. On the same network it
// points straight at the desktop; off it, at the relay, which splices the browser
// through to that same proxy — either way the desktop decides whether to serve it.
//
// What is forwarded is the whole site, not one page: the token swaps itself for a
// Path=/ cookie on first hit, so once a port is open the browser can walk to any
// path on that address (/login, /admin) by typing it. The address to type them
// onto is the *base* below — never the opened link, which ends in the token. The
// path box says the same thing in app form: land straight on /admin.
import React, { useState } from 'react';
import { View, Text, TextInput, Button, FlatList, Pressable, Alert, StyleSheet, Linking } from 'react-native';
import { useConnection } from '../api/context';

type Fwd = { port: number; url: string; base: string };

// The forwarded site lives at the root of whatever origin the link points at —
// the LAN proxy, or the relay (where the tunnel cookie, not the path, is what
// keeps a request pointed at this desktop). So the origin is the base to append
// paths to, on either transport.
const baseOf = (url: string) => {
  const m = /^https?:\/\/[^/?#]+/i.exec(url);
  return m ? m[0] : url;
};

export default function PortsScreen() {
  const { conn } = useConnection();
  const [portText, setPortText] = useState('3000');
  const [pathText, setPathText] = useState('');
  const [forwards, setForwards] = useState<Fwd[]>([]);
  const [busy, setBusy] = useState(false);

  const open = async (port: number, path?: string) => {
    setBusy(true);
    try {
      const url = await conn!.forwardPort(port, path);
      setForwards((prev) => [{ port, url, base: baseOf(url) }, ...prev.filter((f) => f.port !== port)]);
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert('Ports', String(e?.message ?? e));
    }
    setBusy(false);
  };

  const openTyped = () => {
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return Alert.alert('Ports', 'Enter a valid port.');
    return open(port, pathText.trim() || undefined);
  };

  const stop = (f: Fwd) => {
    conn?.closeForward(f.port);
    setForwards((prev) => prev.filter((x) => x.port !== f.port));
  };

  return (
    <View style={styles.fill}>
      <Text style={styles.hint}>
        Forward a dev server running on the desktop (e.g. localhost:3000) and test it in this phone's browser —
        on this network or away from it. The whole site is forwarded: open it once, then type /login, /admin or any
        other path onto the base address below.
      </Text>
      <View style={styles.rowInput}>
        <TextInput
          style={styles.portInput}
          value={portText}
          onChangeText={setPortText}
          keyboardType="number-pad"
          placeholder="3000"
          placeholderTextColor="#777"
        />
        <TextInput
          style={styles.input}
          value={pathText}
          onChangeText={setPathText}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="/login (optional)"
          placeholderTextColor="#777"
        />
        <Button title="Open" disabled={busy} onPress={openTyped} />
      </View>
      <FlatList
        data={forwards}
        keyExtractor={(f) => String(f.port)}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Pressable style={styles.grow} onPress={() => Linking.openURL(item.url)}>
              <Text style={styles.port}>localhost:{item.port}</Text>
              <Text style={styles.base} selectable numberOfLines={1}>{item.base}/…</Text>
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
  portInput: { width: 72, color: '#fff', backgroundColor: '#2a2a2a', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  input: { flex: 1, color: '#fff', backgroundColor: '#2a2a2a', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#333' },
  grow: { flex: 1 },
  port: { color: '#fff', fontSize: 15 },
  base: { color: '#61afef', fontSize: 12 },
});
