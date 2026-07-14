// What the session is running: which model, and how hard it thinks.
//
// Both are switched *live*, on a session already in flight — main types the CLI's own
// `/model <id>` / `/effort <level>` command into the TUI and remembers the choice, so a
// session resumed later comes back running what you last set (src/main/sessions.js). The
// desktop keeps its model badge in the session bar; a phone has no room for two badges
// beside a title, so the two live together in this sheet.
//
// A pick applies immediately and the sheet closes behind it — there is no Apply button,
// because there is nothing to confirm: the switch takes effect on the running session the
// moment it is tapped, and tapping another one switches again.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DEFAULT_MODEL, EFFORTS, MODELS } from '../../api/models';
import { color, font, radius, space } from '../../theme';

type Props = {
  visible: boolean;
  model: string;
  effort: string;
  onPickModel: (id: string) => void;
  onPickEffort: (id: string) => void;
  onClose: () => void;
};

export default function SessionOptions({ visible, model, effort, onPickModel, onPickEffort, onClose }: Props) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    anim.setValue(0);
    Animated.timing(anim, {
      toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  // Every way out runs the collapse first and drops the sheet only when it lands — the
  // parent's `visible` is what unmounts it, so closing it directly would cut the
  // animation off at the first frame.
  const close = () => {
    Animated.timing(anim, {
      toValue: 0, duration: 120, easing: Easing.in(Easing.quad), useNativeDriver: true,
    }).start(({ finished }) => { if (finished) onClose(); });
  };

  const sheetStyle = {
    opacity: anim,
    transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }],
  };

  // The current value is whatever the session reports; an empty one is the CLI's own
  // default, which is what each list's first row means.
  const currentModel = model || DEFAULT_MODEL;
  const currentEffort = effort || 'auto';

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      <Animated.View style={[styles.backdrop, { opacity: anim }]}>
        <Pressable style={styles.dismiss} onPress={close} accessibilityLabel="Close" />
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <View style={styles.grabber} />
          <ScrollView contentContainerStyle={styles.body} bounces={false}>
            <Text style={styles.section}>Model</Text>
            {MODELS.map((m) => (
              <Row
                key={m.id}
                label={m.id === DEFAULT_MODEL ? 'Default' : m.name}
                hint={m.id === DEFAULT_MODEL ? 'Whatever the CLI picks' : undefined}
                on={m.id === currentModel}
                onPress={() => { onPickModel(m.id); close(); }}
              />
            ))}

            <Text style={[styles.section, styles.sectionGap]}>Effort</Text>
            {EFFORTS.map((e) => (
              <Row
                key={e.id}
                label={e.name}
                hint={e.hint}
                on={e.id === currentEffort}
                onPress={() => { onPickEffort(e.id); close(); }}
              />
            ))}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function Row({ label, hint, on, onPress }: { label: string; hint?: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, on && styles.rowLabelOn]}>{label}</Text>
        {!!hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      {on && <Ionicons name="checkmark" size={16} color={color.accent} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  // Everything above the sheet dismisses it, so the sheet itself never has to.
  dismiss: { flex: 1 },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border,
    maxHeight: '80%',
  },
  grabber: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: radius.pill,
    backgroundColor: color.border, marginTop: space.sm,
  },
  body: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xl },
  section: {
    color: color.faint, fontSize: font.size.xs, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginBottom: space.sm, marginLeft: space.xs,
  },
  sectionGap: { marginTop: space.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: 10,
    borderRadius: radius.sm,
  },
  rowPressed: { backgroundColor: color.raised },
  rowText: { flex: 1 },
  rowLabel: { color: color.text, fontSize: font.size.md },
  rowLabelOn: { color: color.accent, fontWeight: '600' },
  rowHint: { color: color.muted, fontSize: font.size.xs, marginTop: 1 },
});
