// Landing screen, in the three states a phone can be in before it is driving a
// window: not paired with a machine (scan a QR), paired and dialling it, or paired
// and holding a list of windows to choose between.
//
// They are one screen rather than three because they are one moment to the user —
// "which desktop am I about to drive?" — and because the machine only tells you how
// many windows it has *after* you have connected to it, so the pair prompt and the
// chooser cannot be separate destinations you navigate between.
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../api/context';
import { Instance, uptime } from '../api/instances';
import { basename } from '../components/ProjectDrawer';

// The desktop mark: three status-coloured dots — the product is many parallel
// sessions, so it is a cluster rather than a single glyph.
const DOTS = ['#3fb950', '#d29922', '#a371f7'];

const STEPS = [
  'Open the desktop IDE on the machine you want to drive.',
  'Go to Settings → Remote access and turn it on.',
  'Scan the QR code it shows with this phone.',
];

// One window. The project is what you actually recognise it by, so it leads; the
// uptime is what tells two windows on the same project apart, which is exactly when
// you need it most.
function InstanceRow({ inst, onPress }: { inst: Instance; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.instance, pressed && styles.instancePressed]}
      onPress={onPress}
    >
      <Ionicons name="desktop-outline" size={20} color="#4da3ff" />
      <View style={styles.instanceText}>
        <Text style={styles.instanceName} numberOfLines={1}>
          {inst.project ? basename(inst.project) : 'No project open'}
        </Text>
        <Text style={styles.instancePath} numberOfLines={1}>
          {inst.project ?? 'Pick a project once you are in'}
        </Text>
        <Text style={styles.instanceMeta}>Opened {uptime(inst.startedAt)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#7d8590" />
    </Pressable>
  );
}

export default function WelcomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { conn, state, instances, selectInstance, unpair } = useConnection();

  const choosing = !!instances && instances.length > 0;
  const connecting = !choosing && !!conn && state !== 'error';

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

      {choosing ? (
        <>
          <Text style={styles.tagline}>
            {instances!.length} windows are open on this machine.
          </Text>
          <Text style={styles.explainer}>
            Each one has its own project and its own sessions. Pick the one to drive.
          </Text>

          <Text style={styles.eyebrow}>Windows</Text>
          {instances!.map((inst) => (
            <InstanceRow key={inst.id} inst={inst} onPress={() => selectInstance(inst)} />
          ))}

          <Text style={styles.note}>
            Oldest first. You can switch windows later from the project drawer.
          </Text>
        </>
      ) : connecting ? (
        <>
          <Text style={styles.tagline}>Connecting to your desktop…</Text>
          <ActivityIndicator style={styles.spinner} color="#4da3ff" />
          <Text style={styles.explainer}>
            The IDE has to be running with remote access on. This phone tries the local
            network first, then the relay.
          </Text>
          <Pressable style={styles.unpair} onPress={unpair}>
            <Ionicons name="log-out-outline" size={18} color="#f85149" />
            <Text style={styles.unpairText}>Unpair</Text>
          </Pressable>
        </>
      ) : (
        <>
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
            You pair with the machine, not one window — if the IDE is open several times,
            you pick which to drive right after scanning.
          </Text>
        </>
      )}
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
  spinner: { marginTop: 20 },

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

  instance: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8, borderRadius: 8,
    backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: StyleSheet.hairlineWidth,
  },
  instancePressed: { backgroundColor: '#21262d' },
  instanceText: { flex: 1 },
  instanceName: { color: '#e6edf3', fontSize: 15, fontWeight: '600' },
  instancePath: { color: '#7d8590', fontSize: 11, marginTop: 2 },
  instanceMeta: { color: '#7d8590', fontSize: 11, marginTop: 4 },

  step: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  stepNum: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: '#21262d',
    color: '#4da3ff', fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 22,
  },
  stepText: { flex: 1, color: '#e6edf3', fontSize: 13, lineHeight: 19 },

  note: { color: '#7d8590', fontSize: 12, lineHeight: 18, marginTop: 24, textAlign: 'center' },

  unpair: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 28, paddingVertical: 10 },
  unpairText: { color: '#f85149', fontSize: 14, fontWeight: '600' },
});
