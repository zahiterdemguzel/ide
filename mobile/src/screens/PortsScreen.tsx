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
import { View, Text, TextInput, FlatList, Pressable, Alert, StyleSheet, Linking } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import ScreenHeader from '../components/ScreenHeader';
import { Card, CategoryLabel, Button } from '../components/ui';
import { showError } from '../components/ErrorDialog';
import { color, radius, font, type } from '../theme';

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
      showError('Ports', e);
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
      <ScreenHeader
        title="Ports"
        subtitle="Forward a desktop dev server and open it in this phone's browser — on this network or away from it."
      />

      <FlatList
        data={forwards}
        keyExtractor={(f) => String(f.port)}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <Card style={styles.form}>
              <View style={styles.fields}>
                <Field label="Port" style={styles.portField}>
                  <TextInput
                    style={styles.input}
                    value={portText}
                    onChangeText={setPortText}
                    keyboardType="number-pad"
                    placeholder="3000"
                    placeholderTextColor={color.faint}
                  />
                </Field>
                <Field label="Path (optional)" style={styles.pathField}>
                  <TextInput
                    style={styles.input}
                    value={pathText}
                    onChangeText={setPathText}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="/login"
                    placeholderTextColor={color.faint}
                  />
                </Field>
              </View>
              <Button
                label="Open in browser"
                icon="open-outline"
                hue={color.accentDim}
                disabled={busy}
                onPress={openTyped}
                style={styles.openBtn}
              />
            </Card>

            {forwards.length > 0 && (
              <CategoryLabel
                label="Forwarding"
                hue={color.green}
                count={forwards.length}
                style={styles.category}
              />
            )}
          </>
        }
        renderItem={({ item }) => (
          <Card style={styles.fwd}>
            <View style={styles.fwdTop}>
              <View style={styles.live} />
              <Pressable style={styles.grow} onPress={() => Linking.openURL(item.url)}>
                <Text style={styles.host}>localhost:{item.port}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.stop, pressed && styles.stopPressed]}
                onPress={() => stop(item)}
                accessibilityLabel={`Stop forwarding port ${item.port}`}
              >
                <Ionicons name="close" size={12} color={color.fileRed} />
                <Text style={styles.stopLabel}>Stop</Text>
              </Pressable>
            </View>
            {/* The base, not the opened link: the link ends in a one-time token, and
                this is the address you type other paths onto. */}
            <Text style={styles.base} selectable numberOfLines={1}>{item.base}/…</Text>
          </Card>
        )}
      />
    </View>
  );
}

function Field(
  { label, style, children }:
  { label: string; style?: any; children: React.ReactNode },
) {
  return (
    <View style={[styles.field, style]}>
      <Text style={type.fieldLabel}>{label.toUpperCase()}</Text>
      <View style={styles.well}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The page colour is spelled out because the navigator's DarkTheme would otherwise
  // show through — its background is rgb(1,1,1), a black that belongs to no token and
  // reads as a hole next to #0d1117.
  fill: { flex: 1, backgroundColor: color.bg },
  // No gesture inset here: this is a tab screen, so the tab bar is already below it
  // and reserves whatever the device needs.
  list: { padding: 16 },

  form: { padding: 14 },
  fields: { flexDirection: 'row', gap: 8 },
  field: { gap: 4 },
  portField: { width: 78 },
  pathField: { flex: 1 },
  well: {
    height: 42, justifyContent: 'center', paddingHorizontal: 12,
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border, borderRadius: 9,
  },
  input: { color: color.text, fontSize: font.size.md, fontFamily: font.mono, padding: 0 },
  openBtn: { marginTop: 12 },

  category: { marginTop: 20, marginBottom: 10 },

  fwd: { padding: 13, paddingHorizontal: 14, marginBottom: 10 },
  fwdTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  live: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: color.green,
    shadowColor: color.green, shadowOpacity: 0.9, shadowRadius: 3, shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  host: { color: color.text, fontSize: font.size.md, fontWeight: '600', fontFamily: font.mono },
  stop: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 5, paddingHorizontal: 11, borderRadius: radius.pill,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  stopPressed: { backgroundColor: color.raisedHi },
  stopLabel: { color: color.text, fontSize: 12, fontWeight: '600' },
  base: { color: color.accent, fontSize: 12, fontFamily: font.mono, marginTop: 6 },
});
