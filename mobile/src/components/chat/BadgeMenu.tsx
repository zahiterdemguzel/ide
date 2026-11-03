// A pill in the session bar that says what the session is running, and opens a menu to
// change it. The desktop puts the same control in the same place (its model badge, see
// src/renderer/sessions.js + .effort-badge / .effort-menu in src/styles/sessions.css);
// this is that badge for a phone, and the chat screen mounts one per switchable setting.
//
// The menu is anchored *under the badge it belongs to*, not floated in the middle of the
// screen: with two badges side by side, a menu that didn't point back at its own pill
// would leave you guessing which one you were about to change.
import React, { useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { color, font, radius, shadow, space, MODAL_TOP_SHIFT } from '../../theme';

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
// A floor, not a width: under a large accessibility font the labels need more room,
// and a fixed width wrapped every item onto two lines. The ceiling is the screen.
const MENU_MIN_WIDTH = 190;
const GAP = 6;
const MARGIN = 8;
// The badge is ~18pt tall; this grows its target to the 44pt minimum vertically.
// Sideways it stays small — the model and effort badges sit 6pt apart.
const BADGE_SLOP = { top: 13, bottom: 13, left: 3, right: 3 };

export default function BadgeMenu({ label, items, current, onPick, accessibilityLabel }: Props) {
  const badge = useRef<View>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  // The badge's left edge and the menu's top; the menu's own left is clamped against
  // its *measured* width at render, since that width follows the font size.
  const [at, setAt] = useState({ x: 0, top: 0 });
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(MENU_MIN_WIDTH);

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
    badge.current?.measureInWindow((x, y, _w, h) => {
      setAt({
        x,
        // measureInWindow is app-window coords; the translucent modal's origin is
        // the screen's, a status bar higher on Android — shift back to line up.
        top: y + h + GAP + MODAL_TOP_SHIFT,
      });
      setOpen(true);
      slide(1);
    });
  };

  // Close on the collapse landing, never before: `open` is what unmounts the menu, so
  // dropping it first would cut the animation off at its first frame.
  const hide = (then?: () => void) => slide(0, () => { setOpen(false); then?.(); });

  const windowSize = Dimensions.get('window');
  // The translucent modal spans the app window plus the status bar it draws under.
  const modalHeight = windowSize.height + MODAL_TOP_SHIFT;
  const left = Math.max(MARGIN, Math.min(at.x, windowSize.width - width - MARGIN));
  // Keep the bottom on screen too: a long list (or a big font) scrolls inside the
  // menu rather than running under the home indicator.
  const maxHeight = Math.max(120, modalHeight - at.top - insets.bottom - MARGIN);

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
        hitSlop={BADGE_SLOP}
        accessibilityLabel={`${accessibilityLabel}: ${label}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.badge, pressed && styles.badgePressed]}
      >
        <Text style={styles.badgeText} numberOfLines={1}>{label}</Text>
        <Ionicons name="chevron-down" size={10} color={color.muted} />
      </Pressable>

      <Modal visible={open} transparent statusBarTranslucent animationType="none" onRequestClose={() => hide()}>
        <Pressable style={styles.backdrop} onPress={() => hide()} accessibilityLabel="Close" />
        <Animated.View
          onLayout={(e) => { setHeight(e.nativeEvent.layout.height); setWidth(e.nativeEvent.layout.width); }}
          style={[styles.menu, { left, top: at.top, maxHeight, maxWidth: windowSize.width - MARGIN * 2 }, menuStyle]}
        >
          <ScrollView bounces={false} contentContainerStyle={styles.menuBody}>
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
          </ScrollView>
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
  // Menus are 12 in the system (cards 14, inputs 10) and carry the menu shadow.
  menu: {
    position: 'absolute', minWidth: MENU_MIN_WIDTH,
    borderRadius: 12,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
    ...shadow.menu,
  },
  menuBody: { padding: 4, gap: 2 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.sm, paddingVertical: 7, minHeight: 40,
    borderRadius: radius.sm,
  },
  itemPressed: { backgroundColor: color.raised },
  itemText: { flex: 1 },
  itemLabel: { color: color.text, fontSize: font.size.sm },
  itemLabelOn: { color: color.accent, fontWeight: '600' },
  itemHint: { color: color.muted, fontSize: font.size.xs, marginTop: 1 },
});
