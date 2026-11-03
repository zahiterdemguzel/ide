// Session alerts, newest first, grouped by how recent they are — the things that
// happened while the phone was in your pocket. Tapping one goes to the session it
// came from; one with no session (a failed operation, a usage warning) expands in
// place so the whole message can be read and copied.
//
// The alerts are real: AlertFeed (api/notifications.ts) derives them from the
// connection's own pushes — nothing here is a fixture. How they're packed into cards
// is the pure, tested lib/notification-groups.js.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, SectionList, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Card, Divider, EmptyState } from '../components/ui';
import { showToast } from '../components/feedback';
import { color, type, inset, tint } from '../theme';
import { shortAgo } from '../api/time';
import {
  Alert, ALERT_STYLE, useAlerts, markAllRead, markRead,
} from '../api/notifications';
import { alertSections, alertTapAction } from '../lib/notification-groups';

// How many lines of detail a collapsed row shows before it needs expanding.
const COLLAPSED_LINES = 2;

export default function NotificationsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const alerts = useAlerts();
  const sections = useMemo(() => alertSections(alerts), [alerts]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Seeing the list is reading it: everything is marked read when you leave, so the
  // bell clears itself. On leave rather than on open, so the unread glow still shows
  // which alerts are new while you're looking at them.
  useEffect(() => markAllRead, []);

  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const open = (a: Alert) => {
    markRead(a.id);
    const action = alertTapAction(a);
    if (action === 'session') navigation.navigate('Chat', { id: a.sessionId });
    else if (action === 'expand') toggleExpanded(a.id);
  };

  const copy = async (a: Alert) => {
    await Clipboard.setStringAsync(`${a.title}\n\n${a.detail}`);
    showToast({ message: 'Copied to clipboard', tone: 'success' });
  };

  const renderRow = (a: Alert) => (
    <AlertRow
      alert={a}
      expanded={expanded.has(a.id)}
      onPress={() => open(a)}
      onCopy={() => copy(a)}
    />
  );

  return (
    <View style={styles.fill}>
      {/* Measured, not the design's iPhone constant: an Android status bar is about
          half a notch's height, and hardcoding one over-tall frame per screen is the
          bug this app already had. Same floor as ScreenHeader. */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
        <View style={styles.top}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={10}
            style={styles.back}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={24} color={color.text} />
          </Pressable>
        </View>
        <Text style={styles.title} accessibilityRole="header">Notifications</Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(block) => block.key}
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
        // Each item is a whole card: an unread alert alone (its glow is the point,
        // and it can't be drawn on a row inside a shared border), or a run of read
        // alerts sharing one card with hairlines between them.
        renderItem={({ item: block }) => (
          block.unread ? (
            <Card hue={ALERT_STYLE[block.alerts[0].kind].hue} style={styles.card}>
              {renderRow(block.alerts[0])}
            </Card>
          ) : (
            <Card style={styles.card}>
              {block.alerts.map((a, i) => (
                <React.Fragment key={a.id}>
                  {i > 0 && <Divider inset={55} />}
                  {renderRow(a)}
                </React.Fragment>
              ))}
            </Card>
          )
        )}
        ListEmptyComponent={(
          <EmptyState
            icon="notifications-off-outline"
            title="Nothing to catch up on"
            message="Sessions that need you, failures and usage warnings show up here."
          />
        )}
      />
    </View>
  );
}

function AlertRow(
  { alert: a, expanded, onPress, onCopy }:
  { alert: Alert; expanded: boolean; onPress: () => void; onCopy: () => void },
) {
  const { icon, hue } = ALERT_STYLE[a.kind];
  const action = alertTapAction(a);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${a.title}. ${a.detail}`}
      accessibilityHint={
        action === 'session' ? 'Opens the session'
          : action === 'expand' ? (expanded ? 'Collapses the message' : 'Shows the full message')
            : undefined
      }
      accessibilityState={action === 'expand' ? { expanded } : undefined}
    >
      <View style={[styles.tile, { backgroundColor: a.unread ? tint.fillStrong(hue) : tint.fill(hue) }]}>
        <Ionicons name={icon} size={17} color={hue} />
      </View>
      <View style={styles.text}>
        <Text style={styles.rowTitle} numberOfLines={expanded ? undefined : 1}>{a.title}</Text>
        <Text
          style={[styles.detail, expanded && styles.detailExpanded]}
          numberOfLines={expanded ? undefined : COLLAPSED_LINES}
          selectable={expanded}
        >
          {a.detail}
        </Text>
        {expanded && (
          <Pressable
            onPress={onCopy}
            hitSlop={12}
            style={styles.copy}
            accessibilityRole="button"
            accessibilityLabel="Copy message"
          >
            <Ionicons name="copy-outline" size={14} color={color.accent} />
            <Text style={styles.copyLabel}>Copy</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.meta}>
        <Text style={type.time}>{shortAgo(a.at)}</Text>
        {a.unread && <View style={[styles.unread, { backgroundColor: hue }]} />}
        {action === 'session' && <Ionicons name="chevron-forward" size={14} color={color.iconFaint} />}
        {action === 'expand' && (
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={color.iconFaint} />
        )}
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
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44 },
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  title: { ...type.largeTitle, paddingTop: 6, paddingBottom: 12 },

  list: { padding: 16 },
  group: { ...type.category, color: color.muted, marginBottom: 10, marginTop: 10 },

  card: { marginBottom: 10 },

  row: { flexDirection: 'row', gap: 11, paddingVertical: 13, paddingHorizontal: 14 },
  rowPressed: { opacity: 0.6 },
  tile: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { flex: 1, minWidth: 0 },
  rowTitle: { color: color.text, fontSize: 14, fontWeight: '600' },
  detail: { color: color.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  detailExpanded: { color: color.body },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 8, minHeight: 24 },
  copyLabel: { color: color.accent, fontSize: 13, fontWeight: '600' },
  meta: { alignItems: 'flex-end', gap: 6 },
  unread: { width: 8, height: 8, borderRadius: 4 },
});
