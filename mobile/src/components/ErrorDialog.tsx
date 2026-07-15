// The one place a phone shows an error. A native `Alert.alert` only offers OK and
// its text can't be selected — useless when the error is a git stderr or a stack
// trace the user needs to send on. This modal shows the whole message in a
// scrollable monospace box with **Copy** beside OK.
//
// It's driven imperatively: `showError(title, message)` can be called from anywhere
// — component or not, catch block or event handler — because a mounted <ErrorDialog/>
// at the app root registers itself as the single sink. Later calls replace the shown
// error rather than stacking modals.
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { color, font, radius, space } from '../theme';

export type AppError = { title: string; message: string };

let sink: ((e: AppError | null) => void) | null = null;

// Turn whatever landed in a catch block into a readable string.
export function errorText(e: any): string {
  if (e == null) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message ?? e.error ?? e.stderr ?? String(e);
}

export function showError(title: string, message?: any): void {
  sink?.({ title, message: message == null ? '' : errorText(message) });
}

export default function ErrorDialog() {
  const [err, setErr] = useState<AppError | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    sink = (e) => { setErr(e); setCopied(false); };
    return () => { sink = null; };
  }, []);

  if (!err) return null;

  const copy = async () => {
    const full = err.message ? `${err.title}\n\n${err.message}` : err.title;
    await Clipboard.setStringAsync(full);
    setCopied(true);
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => setErr(null)}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{err.title}</Text>
          {err.message ? (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <Text style={styles.message} selectable>{err.message}</Text>
            </ScrollView>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
              onPress={copy}
            >
              <Text style={styles.btnText}>{copied ? 'Copied' : 'Copy'}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.btnPrimaryPressed]}
              onPress={() => setErr(null)}
            >
              <Text style={[styles.btnText, styles.btnPrimaryText]}>OK</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  title: { color: color.text, fontSize: font.size.lg, fontWeight: '600', marginBottom: space.md },
  body: { maxHeight: 260, backgroundColor: color.bg, borderRadius: radius.md, marginBottom: space.lg },
  bodyContent: { padding: space.md },
  message: { color: color.redSoft, fontFamily: font.mono, fontSize: font.size.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  btn: {
    minWidth: 76,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.raised,
    alignItems: 'center',
  },
  btnPressed: { backgroundColor: color.raisedHi },
  btnPrimary: { backgroundColor: color.accentDim },
  btnPrimaryPressed: { backgroundColor: color.accent },
  btnText: { color: color.text, fontSize: font.size.md, fontWeight: '600' },
  btnPrimaryText: { color: '#fff' },
});
