// Every tab's header. It replaces the navigator's own (App.tsx turns that off)
// because the design puts the large title, the project switcher and the usage ring
// on one surface — a stock header can hold the row but not the title under it.
//
// The two side actions bracket the top row: project switcher on the left, the run
// panel (launch configs, tasks, and the terminals they opened) on the right. Both
// live in MainTabs, which owns the drawers — the screens reach them through
// ChromeContext rather than each re-implementing a drawer of its own.
//
// `title`, `subtitle` and `children` are all optional. Pass none and the frame is
// the toolbar alone — which is what Git wants, its branch chip being a better
// answer to "where am I" than a heading repeating the tab bar.

import React, { createContext, useContext, useId, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { color, radius, type, inset } from '../theme';
import { useUsage, windowUtil, windowResetIn, rampColor } from '../api/usage';
import { useUnreadCount } from '../api/notifications';
import { UsageRing } from './ui';
import UsagePanel from './UsagePanel';
import { basename } from './ProjectDrawer';

// The gutter the header's content sits in, before any display cutout is added.
const GUTTER = 16;

type Chrome = { project: string | null; openProjects: () => void; openRun: () => void };

export const ChromeContext = createContext<Chrome>({
  project: null,
  openProjects: () => {},
  openRun: () => {},
});

export default function ScreenHeader(
  { title, subtitle, children }:
  { title?: string; subtitle?: string; children?: React.ReactNode },
) {
  const { project, openProjects, openRun } = useContext(ChromeContext);
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const usage = useUsage();
  const util = windowUtil(usage, '5h');
  // The ring's centre: when the 5h window rolls over. The arc alone says how much is
  // spent but not the one thing you want next — how long until it isn't.
  const resetIn = windowResetIn(usage, '5h');
  const [usageOpen, setUsageOpen] = useState(false);
  const unread = useUnreadCount();

  // Every mounted header would otherwise declare the same `id="hdr"`, and the tab
  // navigator keeps all four alive at once — react-native-svg resolves `url(#id)`
  // against a registry that duplicate ids collide in. useId gives each instance its
  // own; the strip keeps it a valid SVG name (useId's output contains colons).
  const gradientId = `hdr${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <View style={styles.header}>
      {/* RN has no background gradient, and the two stops are one shade apart — but
          it's what separates the header from the cards below it on an OLED screen.
          Drawn with react-native-svg, which is already a dependency; a gradient
          package would be a native module and a rebuild for one rectangle.

          This fills the header because the header itself carries NO padding — the
          gutter is on `content` instead. Yoga insets absolutely-positioned children
          by their parent's padding (unlike CSS, where the containing block is the
          padding box), so a padded parent here left the gradient short of the edges
          and the page's near-black showing through. */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color.surface} />
            <Stop offset="1" stopColor={color.surfaceDeep} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
      </Svg>

      <View
        style={[
          styles.content,
          {
            // Measured, never a constant: the mock's 54 is an iPhone notch, and an
            // Android status bar is roughly half that.
            paddingTop: Math.max(insets.top, inset.minTop),
            // A display cutout only eats the gutter in landscape, and only on the
            // side it's on — the gradient still bleeds under it either way.
            paddingLeft: GUTTER + insets.left,
            paddingRight: GUTTER + insets.right,
          },
        ]}
      >
        <View style={styles.top}>
        <Pressable
          style={({ pressed }) => [styles.projectPill, pressed && styles.pillPressed]}
          onPress={openProjects}
          accessibilityLabel="Switch project"
        >
          <Ionicons name="folder-open-outline" size={14} color={color.accent} />
          <Text style={styles.projectName} numberOfLines={1}>
            {project ? basename(project) : 'Select project'}
          </Text>
          <Ionicons name="chevron-down" size={11} color={color.muted} />
        </Pressable>

        <View style={styles.actions}>
          {util !== null && (
            <Pressable
              onPress={() => setUsageOpen(true)}
              hitSlop={8}
              accessibilityLabel={
                `Usage, ${Math.round(util * 100)} percent of the 5-hour limit used`
                + (resetIn ? `, resets in ${resetIn}` : '')
              }
            >
              <UsageRing util={util} hue={rampColor(util)} label={resetIn} />
            </Pressable>
          )}
          {/* The alerts screen has no entry point in the design — it's drawn with a
              back chevron, so it's pushed from somewhere, and the tab bar it draws
              has no fifth tab. This bell is that somewhere. */}
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pillPressed]}
            onPress={() => navigation.navigate('Notifications')}
            accessibilityLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          >
            <Ionicons name={unread ? 'notifications' : 'notifications-outline'} size={16} color={unread ? color.accent : color.muted} />
            {unread > 0 && <View style={styles.badge} />}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pillPressed]}
            onPress={openRun}
            accessibilityLabel="Run and tasks"
          >
            <Ionicons name="play" size={16} color={color.green} />
          </Pressable>
        </View>
      </View>

        {/* Most tabs are titled; Browser passes none — every vertical pixel there
            belongs to the streamed page, and its URL bar already says where you are. */}
        {title ? (
          <Text style={[styles.title, subtitle ? styles.titleTight : null]} numberOfLines={1}>{title}</Text>
        ) : (
          <View style={styles.untitledGap} />
        )}
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </View>

      <UsagePanel visible={usageOpen} view={usage} onClose={() => setUsageOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  // No padding here — see the Svg's note. The flat surface is a floor under the
  // gradient: if it ever fails to paint, this reads as the header's own colour
  // rather than as a hole punched through to the page.
  header: {
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
  },
  // The gutter lives here so the gradient above can run edge to edge under it.
  content: { paddingBottom: 0 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  projectPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: color.raised, borderRadius: radius.pill,
    paddingLeft: 8, paddingRight: 10, paddingVertical: 5,
    maxWidth: 200,
  },
  pillPressed: { backgroundColor: color.raisedHi },
  projectName: { color: color.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: color.raised,
    alignItems: 'center', justifyContent: 'center',
  },
  // A dot, not a count: the number is on the screen the bell opens, and a badge
  // that has to stay legible at 8px can only really say "something's there".
  badge: {
    position: 'absolute', top: 7, right: 8,
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: color.green,
    borderWidth: 1.5, borderColor: color.surfaceDeep,
  },
  title: { ...type.largeTitle, paddingTop: 10, paddingBottom: 12 },
  // No title: keep a sliver of air under the chrome row so it doesn't sit flush
  // on whatever the screen puts next.
  untitledGap: { height: 8 },
  // A subtitle takes over the gap under the title, so the two read as one block.
  titleTight: { paddingBottom: 4 },
  subtitle: { color: color.muted, fontSize: 13, lineHeight: 19, paddingBottom: 14 },
});
