// Session alerts, newest first, grouped by how recent they are — the things that
// happened while the phone was in your pocket. Tapping one goes to the session it
// came from.
//
// The alerts are real: AlertFeed (api/notifications.ts) derives them from the
// connection's own pushes — nothing here is a fixture.

import React, { useEffect } from 'react';
import { View, Text, Pressable, SectionList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Card, Divider } from '../components/ui';
import { color, radius, type, inset, tint } from '../theme';
import { shortAgo } from '../api/time';
import {
  Alert, ALERT_STYLE, useAlerts, groupAlerts, markAllRead, markRead,
} from '../api/notifications';

export default function NotificationsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const alerts = useAlerts();
  const sections = groupAlerts(alerts);

  // Seeing the list is reading it: everything is marked read when you leave, so the
  // bell clears itself. On leave rather than on open, so the unread glow still shows
  // which alerts are new while you're looking at them.
  useEffect(() => markAllRead, []);

  const open = (a: Alert) => {
    markRead(a.id);
    if (a.sessionId) navigation.navigate('Chat', { id: a.sessionId });
  };

  return (
    <View style={styles.fill}>
      {/* Measured, not the design's iPhone constant: an Android status bar is about
          half a notch's height, and hardcoding one over-tall frame per screen is the
          bug this app already had. Same floor as ScreenHeader. */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
        <View style={styles.top}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={10} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={24} color={color.text} />
          </Pressable>
        </View>
        <Text style={styles.title}>Notifications</Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(a) => a.id}
        stickySectionHeadersEnabled={false}
        // Unlike the tabs, this one is full-screen with no tab bar under it, so the
        // list itself has to clear the gesture bar — by the device's number, not a
        // constant (Android reports 0 and paints its own strip below the window).
        contentContainerStyle={[
          sections.length ? styles.list : styles.fill,
          { paddingBottom: insets.bottom + 16 },
        ]}
        renderSectionHeader={({ section }) => (
          <Text style={styles.group}>{section.label.toUpperCase()}</Text>
        )}
        // Alerts in a group are one card with hairlines between them, but an unread
        // one gets its own glowing card — the glow is the point, and it can't be
        // drawn on a row inside a shared border.
        renderItem={({ item, index, section }) => (
          item.unread ? (
            <Card hue={ALERT_STYLE[item.kind].hue} style={styles.solo}>
              <AlertRow alert={item} onPress={() => open(item)} />
            </Card>
          ) : (
            <Card style={[styles.grouped, first(index) && styles.groupedFirst, last(index, section.data.length) && styles.groupedLast]}>
              {index > 0 && <Divider inset={55} />}
              <AlertRow alert={item} onPress={() => open(item)} />
            </Card>
          )
        )}
        ListEmptyComponent={<Text style={styles.empty}>Nothing to catch up on.</Text>}
      />
    </View>
  );
}

const first = (i: number) => i === 0;
const last = (i: number, n: number) => i === n - 1;

function AlertRow({ alert: a, onPress }: { alert: Alert; onPress: () => void }) {
  const { icon, hue } = ALERT_STYLE[a.kind];
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <View style={[styles.tile, { backgroundColor: a.unread ? tint.fillStrong(hue) : tint.fill(hue) }]}>
        <Ionicons name={icon} size={17} color={hue} />
      </View>
      <View style={styles.text}>
        <Text style={styles.rowTitle} numberOfLines={1}>{a.title}</Text>
        <Text style={styles.detail} numberOfLines={2}>{a.detail}</Text>
      </View>
      <View style={styles.meta}>
        <Text style={type.time}>{shortAgo(a.at)}</Text>
        {a.unread && <View style={[styles.unread, { backgroundColor: hue }]} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  header: {
    paddingHorizontal: 16,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.borderSoft,
  },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  title: { ...type.largeTitle, paddingTop: 10, paddingBottom: 12 },

  list: { padding: 16 },
  group: { ...type.category, color: color.muted, marginBottom: 10, marginTop: 10 },

  solo: { marginBottom: 10 },
  // Rows of one group share a card: square the joins so consecutive rows read as
  // one surface rather than a stack of separate cards.
  grouped: { borderRadius: 0, borderTopWidth: 0, borderBottomWidth: 0 },
  groupedFirst: { borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card, borderTopWidth: 1 },
  groupedLast: { borderBottomLeftRadius: radius.card, borderBottomRightRadius: radius.card, borderBottomWidth: 1 },

  row: { flexDirection: 'row', gap: 11, paddingVertical: 13, paddingHorizontal: 14 },
  rowPressed: { opacity: 0.6 },
  tile: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { flex: 1, minWidth: 0 },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
  detail: { color: color.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  meta: { alignItems: 'flex-end', gap: 6 },
  unread: { width: 8, height: 8, borderRadius: 4 },

  empty: { color: color.muted, textAlign: 'center', marginTop: 48 },
});
