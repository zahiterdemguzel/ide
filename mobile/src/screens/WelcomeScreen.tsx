// Landing screen for a phone that isn't paired with a desktop yet: the desktop's
// welcome page (dot mark, tagline, action list) reshaped for touch. The camera
// lives one tap away on PairScreen rather than opening itself on launch.
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The desktop mark: three status-coloured dots — the product is many parallel
// sessions, so it is a cluster rather than a single glyph.
const DOTS = ['#3fb950', '#d29922', '#a371f7'];

const STEPS = [
  'Open the desktop IDE on the machine you want to drive.',
  'Go to Settings → Remote access and turn it on.',
  'Scan the QR code it shows with this phone.',
];

export default function WelcomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.body, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 }]}
    >
      <View style={styles.mark}>
        <View style={styles.dots}>
          {DOTS.map((c) => <View key={c} style={[styles.dot, { backgroundColor: c }]} />)}
        </View>
        <Text style={styles.word}>IDE</Text>
      </View>

      <Text style={styles.tagline}>Run many Claude sessions at once.</Text>
      <Text style={styles.explainer}>
        Pair with the desktop IDE to drive its sessions, git, files and dev servers from your phone.
      </Text>

      <Text style={styles.eyebrow}>Start</Text>
      <Pressable
        style={({ pressed }) => [styles.action, styles.actionPrimary, pressed && styles.actionPrimaryPressed]}
        onPress={() => navigation.navigate('Pair')}
      >
        <Ionicons name="qr-code-outline" size={18} color="#fff" />
        <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>Scan QR code</Text>
      </Pressable>

      <Text style={styles.eyebrow}>How to pair</Text>
      {STEPS.map((step, i) => (
        <View key={step} style={styles.step}>
          <Text style={styles.stepNum}>{i + 1}</Text>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}

      <Text style={styles.note}>
        The phone and the desktop must be on the same trusted network — the link is unencrypted LAN traffic.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0d1117' },
  body: { paddingHorizontal: 24, alignItems: 'center' },

  mark: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dots: { flexDirection: 'row', gap: 5 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  word: { color: '#e6edf3', fontSize: 40, fontWeight: '200', letterSpacing: 6 },

  tagline: { color: '#7d8590', fontSize: 14, marginTop: 12, textAlign: 'center' },
  explainer: { color: '#7d8590', fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: 'center' },

  eyebrow: {
    alignSelf: 'stretch', marginTop: 28, marginBottom: 10, paddingBottom: 6,
    color: '#7d8590', fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase',
    borderBottomColor: '#30363d', borderBottomWidth: StyleSheet.hairlineWidth,
  },

  action: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 14, borderRadius: 8,
  },
  actionPrimary: { backgroundColor: '#0e639c' },
  actionPrimaryPressed: { backgroundColor: '#1177bb' },
  actionLabel: { fontSize: 15, fontWeight: '600', color: '#e6edf3' },
  actionLabelPrimary: { color: '#fff' },

  step: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  stepNum: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: '#21262d',
    color: '#4da3ff', fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 22,
  },
  stepText: { flex: 1, color: '#e6edf3', fontSize: 13, lineHeight: 19 },

  note: { color: '#7d8590', fontSize: 12, lineHeight: 18, marginTop: 24, textAlign: 'center' },
});
