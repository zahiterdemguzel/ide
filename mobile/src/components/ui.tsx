// The shared pieces of the phone's design system: the card, the category label a
// list groups under, the orbiting edge that marks running work, the tinted status badge,
// and the buttons. Screens compose these instead of respelling paddings and hexes,
// which is how the six of them stay one product.
//
// The status dot and the working spinner are deliberately NOT here — StateDot
// already draws both (and celebrates a finished run), so it stays the one place a
// session's state becomes a colour.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, Animated, Easing, StyleSheet,
  type ViewStyle, type StyleProp,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Circle, Rect } from 'react-native-svg';
import { color, radius, font, type, motion, shadow, tint } from '../theme';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

// A surface holding one thing. `hue` lights it up — the green ring and glow that
// marks a session waiting on you. `orbit` sends that hue travelling around the card's
// edge, which is what separates work still running from a card that is merely lit.
export function Card(
  { children, hue, orbit, style }:
  { children: React.ReactNode; hue?: string; orbit?: boolean; style?: StyleProp<ViewStyle> },
) {
  return (
    <View
      style={[
        styles.card,
        // An orbiting card draws its own edge, so it keeps the shadow's glow but not a
        // second, static border underneath the lap.
        hue ? { borderColor: orbit ? 'transparent' : tint.glowLine(hue), shadowColor: hue, ...styles.cardGlow } : null,
        style,
      ]}
    >
      {children}
      {hue && orbit && <OrbitGlow hue={hue} radius={radius.card - 1} />}
    </View>
  );
}

// The travelling edge on a working card: a bright segment of the hue that laps the
// card's whole border — down the side, around each corner, back to the top. The
// static border can't carry "right now" (a still ring reads the same whether the
// session is running or stalled), and a ring that merely breathes says "alive" without
// saying "moving". A lap does both, and it's the same idea as the working dot's
// spinner scaled up to the card.
//
// Drawn as an SVG stroke rather than a View: the trip has to follow the rounded
// corners, and only a stroked path does that. The segment is one dash in a
// two-dash-per-perimeter pattern, so sliding `strokeDashoffset` by exactly one
// perimeter per cycle lands the dash back where it started — seamless, no jump.
//
// This is the one animation here that can't use the native driver (RN can't hand SVG
// props to it), so it ticks on the JS thread. That's affordable because it's bounded
// by what's on screen: only *working* cards mount it, and the list shows a handful.
function OrbitGlow({ hue, radius: rx }: { hue: string; radius: number }) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const t = useRef(new Animated.Value(0)).current;

  const S = 2;
  // The rect sits half a stroke in, so the stroke lands inside the card rather than
  // half-clipped by its `overflow: hidden`.
  const W = box.w - S;
  const H = box.h - S;
  // Exact for a rounded rect: the four straight runs, plus four quarter-corners that
  // add up to one whole circle. Exactness is the point — an approximation would drift
  // the dash a little every lap and show up as a stutter at the seam.
  const perimeter = 2 * (W - 2 * rx) + 2 * (H - 2 * rx) + 2 * Math.PI * rx;
  const segment = perimeter * 0.28;

  useEffect(() => {
    if (perimeter <= 0) return undefined;
    t.setValue(0);
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: motion.orbit,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [perimeter, t]);

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {perimeter > 0 && (
        <Svg width={box.w} height={box.h}>
          {/* The dim full lap under the segment, so the edge stays lit between passes
              and the bright part reads as travelling along it rather than as the only
              thing there. */}
          <Rect
            x={S / 2} y={S / 2} width={W} height={H} rx={rx}
            stroke={tint.line(hue)} strokeWidth={S} fill="none"
          />
          <AnimatedRect
            x={S / 2} y={S / 2} width={W} height={H} rx={rx}
            stroke={hue} strokeWidth={S} fill="none" strokeLinecap="round"
            strokeDasharray={`${segment},${perimeter - segment}`}
            strokeDashoffset={t.interpolate({ inputRange: [0, 1], outputRange: [0, -perimeter] })}
          />
        </Svg>
      )}
    </View>
  );
}

// The label a group of rows sits under — NEEDS YOU, WORKING, STAGED, FORWARDING.
// The hue carries the meaning, so it's required; `count` renders the pill beside it.
export function CategoryLabel(
  { label, hue, count, style }:
  { label: string; hue: string; count?: number; style?: StyleProp<ViewStyle> },
) {
  return (
    <View style={[styles.category, style]}>
      <Text style={[type.category, { color: hue }]} numberOfLines={1}>{label.toUpperCase()}</Text>
      {count !== undefined && (
        <View style={[styles.countPill, { backgroundColor: hue === color.muted ? color.raised : tint.fillStrong(hue) }]}>
          <Text style={[styles.countLabel, { color: hue }]}>{count}</Text>
        </View>
      )}
    </View>
  );
}

// A git status square — M/A/U/D — as the system's tinted-badge formula: a wash of
// the hue, a stronger line, the solid hue for the letter.
export function StatusBadge({ letter, hue }: { letter: string; hue: string }) {
  return (
    <View style={[styles.statusBadge, { backgroundColor: tint.fill(hue), borderColor: tint.line(hue) }]}>
      <Text style={[styles.statusLetter, { color: hue }]}>{letter}</Text>
    </View>
  );
}

// A tinted capsule of text — the "+124 −38" diff pill, a model name, a relay URL.
export function Pill(
  { label, hue, style }:
  { label: string; hue?: string; style?: StyleProp<ViewStyle> },
) {
  const solid = hue ?? color.muted;
  return (
    <View style={[styles.pill, hue ? { backgroundColor: tint.fill(hue) } : styles.pillPlain, style]}>
      <Text style={[styles.pillLabel, { color: solid }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  return <View style={[styles.divider, { marginLeft: inset }]} />;
}

// The system's filled button. `hue` defaults to the green every create/commit
// action uses; `tone="secondary"` is the raised grey one.
export function Button(
  { label, icon, onPress, hue = color.greenDeep, tone = 'primary', disabled, style }:
  {
    label: string; icon?: any; onPress: () => void; hue?: string;
    tone?: 'primary' | 'secondary'; disabled?: boolean; style?: StyleProp<ViewStyle>;
  },
) {
  const secondary = tone === 'secondary';
  const fg = disabled ? color.muted : secondary ? color.text : '#fff';
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.buttonSecondary : { backgroundColor: hue },
        disabled && styles.buttonOff,
        pressed && !disabled && styles.buttonPressed,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {icon && <Ionicons name={icon} size={18} color={fg} />}
      <Text style={[styles.buttonLabel, { color: fg }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

// A round or rounded well with an icon in it — the header's actions, a row's
// archive/delete.
export function IconButton(
  { icon, label, onPress, hue = color.muted, size = 19, round, style }:
  {
    icon: any; label: string; onPress: () => void; hue?: string;
    size?: number; round?: boolean; style?: StyleProp<ViewStyle>;
  },
) {
  return (
    <Pressable
      style={({ pressed }) => [
        round ? styles.iconWell : styles.iconBtn,
        pressed && styles.iconBtnPressed,
        style,
      ]}
      onPress={onPress}
      hitSlop={6}
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={size} color={hue} />
    </Pressable>
  );
}

// The usage meter as the header's ring. The desktop's meter and the phone's old
// hairline both ramp green -> yellow -> red as the window fills; this keeps that
// rather than the mock's fixed green, because the colour is the point.
export function UsageRing(
  { util, hue, label, size = 30 }:
  { util: number; hue: string; label?: string; size?: number },
) {
  // Thin, because the ring is a frame around the label rather than the whole story:
  // the arc says how much of the window is spent, the middle says when it comes back.
  // 30/2.5 leaves a 25px hole — enough for the three characters the label ever runs
  // to ("24m", "13h", "2d", "now") at a size still worth reading.
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }}>
      <Svg style={StyleSheet.absoluteFill} width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={color.raised} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={hue}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, util)))}
          strokeLinecap="round"
          // SVG arcs start at 3 o'clock; the meter should fill from the top.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {/* Full-strength ink, not muted: at this size the label needs the contrast, and
          the hue is already spoken for by the arc around it. */}
      {!!label && (
        <View style={styles.ringLabelBox} pointerEvents="none">
          <Text style={styles.ringLabel} numberOfLines={1} allowFontScaling={false}>{label}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.borderSoft,
    overflow: 'hidden',
  },
  cardGlow: { shadowOpacity: 0.07, shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 3 },

  category: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countPill: { borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  countLabel: { fontSize: 10, fontWeight: '700' },

  statusBadge: {
    width: 18, height: 18, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  statusLetter: { fontSize: 10, fontWeight: '700' },

  pill: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  pillPlain: { backgroundColor: color.raised },
  pillLabel: { fontSize: 10.5, fontWeight: '600' },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderSoft },

  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.md,
    ...shadow.thumb,
  },
  buttonSecondary: { backgroundColor: color.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  buttonOff: { backgroundColor: color.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border, shadowOpacity: 0, elevation: 0 },
  buttonPressed: { opacity: 0.85 },
  buttonLabel: { fontSize: font.size.md, fontWeight: '600' },

  // The label is centred in the ring's own box, so it stays put whatever the arc does.
  // allowFontScaling is off on it: a 9px label is sized to the hole it sits in, and a
  // large-text setting would push it out through the stroke rather than reflow.
  ringLabelBox: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  ringLabel: {
    color: color.text, fontSize: 9, fontWeight: '700',
    fontVariant: ['tabular-nums'], includeFontPadding: false,
  },

  iconBtn: { padding: 6, borderRadius: radius.sm },
  iconWell: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: color.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnPressed: { backgroundColor: color.raisedHi },
});
