// A pill in the session bar that says what the session is running, and opens a menu to
// change it. The desktop puts the same control in the same place (its model badge, see
// src/renderer/sessions.js + .effort-badge / .effort-menu in src/styles/sessions.css);
// this is that badge for a phone, and the chat screen mounts one per switchable setting.
//
// The menu is anchored *under the badge it belongs to*, not floated in the middle of the
// screen: with two badges side by side, a menu that didn't point back at its own pill
// would leave you guessing which one you were about to change.
import React, { useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { color, font, radius, space } from '../../theme';

export type MenuItem = { id: string; name: string; hint?: string };

type Props = {
  label: string;
  items: MenuItem[];
  current: string;
  onPick: (id: string) => void;
  accessibilityLabel: string;
};

// The menu grows out of the edge it hangs from, the way the desktop's does
// (`transform-origin: top left`). React Native scales about the centre instead, so the
// top edge would drift down as it grows — the translate below pins it back.
const SCALE = 0.85;
const MENU_WIDTH = 190;
const GAP = 6;
const MARGIN = 8;

export default function BadgeMenu({ label, items, current, onPick, accessibilityLabel }: Props) {
  const badge = useRef<View>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const [height, setHeight] = useState(0);

  const slide = (to: number, done?: () => void) => Animated.timing(anim, {
    toValue: to,
    duration: to ? 140 : 120,
    easing: Easing.out(Easing.quad),
    useNativeDriver: true,
  }).start(done);

  // Where the badge sits on screen is only known once it's laid out, and it moves as the
  // status line's text changes — so measure at the tap, not ahead of it. A badge near the
  // right edge would hang its menu off-screen; keep it inside.
  const show = () => {
    badge.current?.measureInWindow((x, y, w, h) => {
      const screen = Dimensions.get('window').width;
      setAt({
        left: Math.max(MARGIN, Math.min(x, screen - MENU_WIDTH - MARGIN)),
        top: y + h + GAP,
      });
      setOpen(true);
      slide(1);
    });
  };

  // Close on the collapse landing, never before: `open` is what unmounts the menu, so
  // dropping it first would cut the animation off at its first frame.
  const hide = (then?: () => void) => slide(0, () => { setOpen(false); then?.(); });

  const menuStyle = {
    opacity: anim,
    transform: [
      {
        translateY: anim.interpolate({
          inputRange: [0, 1],
          outputRange: [-GAP - (height * (1 - SCALE)) / 2, 0],
        }),
      },
      { scaleY: anim.interpolate({ inputRange: [0, 1], outputRange: [SCALE, 1] }) },
    ],
  };

  return (
    <>
      <Pressable
        ref={badge}
        onPress={show}
        hitSlop={6}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.badge, pressed && styles.badgePressed]}
      >
        <Text style={styles.badgeText} numberOfLines={1}>{label}</Text>
        <Ionicons name="chevron-down" size={10} color={color.muted} />
      </Pressable>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => hide()}>
        <Pressable style={styles.backdrop} onPress={() => hide()} accessibilityLabel="Close" />
        <Animated.View
          onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
          style={[styles.menu, { left: at.left, top: at.top }, menuStyle]}
        >
          {items.map((it) => (
            <Pressable
              key={it.id}
              onPress={() => hide(() => onPick(it.id))}
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              accessibilityRole="button"
              accessibilityState={{ selected: it.id === current }}
            >
              <View style={styles.itemText}>
                <Text style={[styles.itemLabel, it.id === current && styles.itemLabelOn]}>{it.name}</Text>
                {!!it.hint && <Text style={styles.itemHint}>{it.hint}</Text>}
              </View>
              {it.id === current && <Ionicons name="checkmark" size={14} color={color.accent} />}
            </Pressable>
          ))}
        </Animated.View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  badgePressed: { backgroundColor: color.raisedHi },
  badgeText: { color: color.muted, fontSize: font.size.xs, fontWeight: '600' },

  backdrop: { flex: 1 },
  menu: {
    position: 'absolute', width: MENU_WIDTH,
    padding: 4, borderRadius: radius.sm, gap: 2,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.sm, paddingVertical: 7,
    borderRadius: radius.sm,
  },
  itemPressed: { backgroundColor: color.raised },
  itemText: { flex: 1 },
  itemLabel: { color: color.text, fontSize: font.size.sm },
  itemLabelOn: { color: color.accent, fontWeight: '600' },
  itemHint: { color: color.muted, fontSize: font.size.xs, marginTop: 1 },
});
