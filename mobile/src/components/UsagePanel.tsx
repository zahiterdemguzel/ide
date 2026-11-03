// The full usage read-out, opened by tapping the header's ring.
//
// The ring can only say "this much of the 5-hour window is gone". This is the rest
// of what the desktop's toolbar meter shows (src/renderer/usage-meter.js): both
// rolling windows, their exact percentages, and when each one resets. It's a popup
// rather than a screen because it's a glance, not a destination — it grows out of
// the ring it was tapped from and the scrim dismisses it.
//
// Below the windows it lists the desktop's Claude accounts — each one's usage and a
// Switch button — which is the phone's version of the toolbar account pill. When
// the active account is nearly out of its 5-hour window, the account the header
// suggests switching to is highlighted here.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, type, shadow, inset, tint, MODAL_TOP_SHIFT } from '../theme';
import { rampColor, rampTint, windowUtil, type UsageView, type UsageWindow } from '../api/usage';
import { useAccounts, accountLabel, type Account } from '../api/accounts';

const WINDOWS: Array<{ key: string; label: string; caption: string }> = [
  { key: '5h', label: 'Session', caption: 'Rolling 5 hours' },
  { key: '7d', label: 'Weekly', caption: 'Rolling 7 days' },
];

// How often the countdown re-reads the clock while the panel is open. `resetIn` from
// the desktop is a coarse token ("2h") computed at fetch time, so the panel derives
// its own from `resetAt` — a minute is as fine as the text ever gets.
const TICK_MS = 30000;

// "2h 14m", "14m", "under a minute", or "" when the window carries no reset time.
export function formatResetLong(resetAt: number | null, nowMs: number): string {
  if (resetAt == null) return '';
  const mins = Math.round((resetAt - nowMs) / 60000);
  if (mins <= 0) return 'any moment';
  if (mins < 60) return `${mins}m`;
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  const rem = mins % 60;
  return rem ? `${Math.floor(mins / 60)}h ${rem}m` : `${Math.floor(mins / 60)}h`;
}

function resetClock(resetAt: number | null): string {
  if (resetAt == null) return '';
  return new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function WindowRow(
  { win, meta, now }:
  { win: UsageWindow; meta: { label: string; caption: string }; now: number },
) {
  const util = Math.min(1, Math.max(0, win.utilization));
  const hue = rampColor(util);
  const grow = useRef(new Animated.Value(0)).current;

  // The bar fills from empty on open — the one place the number becomes motion, so a
  // near-full weekly window reads as "nearly gone" before the digits are read.
  useEffect(() => {
    Animated.timing(grow, {
      toValue: util,
      duration: 520,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // width percentages can't run on the native driver
    }).start();
  }, [util, grow]);

  const left = formatResetLong(win.resetAt, now);

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={styles.rowLabel}>
          <Text style={styles.label}>{meta.label}</Text>
          {win.representative && (
            <View style={[styles.limitPill, { backgroundColor: rampTint(util, 0.15) }]}>
              <Text style={[styles.limitLabel, { color: hue }]}>LIMITING</Text>
            </View>
          )}
        </View>
        <Text style={[styles.pct, { color: hue }]}>{Math.round(util * 100)}%</Text>
      </View>

      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              backgroundColor: hue,
              width: grow.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>

      <View style={styles.rowBottom}>
        <Text style={styles.caption}>{meta.caption}</Text>
        {!!left && (
          <Text style={styles.caption}>
            Resets in {left}
            {resetClock(win.resetAt) ? ` · ${resetClock(win.resetAt)}` : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

// One account: who it is, how much of each window it has used, and the way to make
// it the active one. Signing in (or renewing an expired login) needs the desktop's
// embedded terminal, so an account that isn't usable says so instead of offering
// a switch — the same rule the desktop's switch prompt follows.
function AccountRow(
  { account, usage, active, suggested, onSwitch }:
  { account: Account; usage: UsageView; active: boolean; suggested: boolean; onSwitch: () => void },
) {
  const fiveHour = windowUtil(usage, '5h');
  const weekly = windowUtil(usage, '7d');
  const expired = account.login === 'expired';
  const parts = [
    fiveHour !== null ? `5h ${Math.round(fiveHour * 100)}%` : null,
    weekly !== null ? `week ${Math.round(weekly * 100)}%` : null,
  ].filter(Boolean);
  const status = expired
    ? 'Login expired — renew on the desktop'
    : !account.loggedIn ? 'Signed out — sign in on the desktop'
    : parts.length ? parts.join(' · ') : (account.email || '');
  return (
    <View
      style={[styles.account, suggested && styles.accountSuggested]}
      accessible={active || !account.loggedIn}
      accessibilityLabel={`${accountLabel(account)}${active ? ', active' : ''}. ${status}`}
    >
      <View style={styles.accountText}>
        <View style={styles.rowLabel}>
          <Text style={styles.accountName} numberOfLines={1}>{accountLabel(account)}</Text>
          {suggested && <Text style={styles.suggestedTag}>SUGGESTED</Text>}
        </View>
        <Text style={[styles.caption, expired && { color: color.red }]} numberOfLines={1}>{status}</Text>
        {fiveHour !== null && account.loggedIn && (
          <View style={[styles.track, styles.miniTrack]}>
            <View style={[styles.fill, { width: `${Math.round(fiveHour * 100)}%`, backgroundColor: rampColor(fiveHour) }]} />
          </View>
        )}
      </View>
      {active ? (
        <View style={[styles.activePill, { backgroundColor: tint.fill(color.green), borderColor: tint.line(color.green) }]}>
          <Text style={[styles.activeLabel, { color: color.green }]}>ACTIVE</Text>
        </View>
      ) : account.loggedIn ? (
        <Pressable
          style={({ pressed }) => [styles.switchBtn, suggested && styles.switchBtnSuggested, pressed && styles.switchBtnPressed]}
          onPress={onSwitch}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Switch to ${accountLabel(account)}${status ? `, ${status}` : ''}`}
        >
          <Text style={[styles.switchLabel, suggested && { color: '#fff' }]}>Switch</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function UsagePanel(
  { visible, view, suggestedAccountId, headerMaxWidth, onClose }:
  {
    visible: boolean; view: UsageView; suggestedAccountId?: string | null;
    // The width ScreenHeader's content stops growing at (it centres beyond it).
    headerMaxWidth: number; onClose: () => void;
  },
) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Read only while open: the per-account usage costs the desktop one API call each.
  const accounts = useAccounts(visible, { withUsage: true });
  const anim = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (visible) { setMounted(true); setNow(Date.now()); }
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 200 : 140,
      easing: visible ? Easing.out(Easing.back(1.4)) : Easing.in(Easing.cubic),
      useNativeDriver: true,
      // The Modal has to outlive the close animation, or the panel would vanish
      // instead of shrinking back into the ring.
    }).start(({ finished }) => { if (finished && !visible) setMounted(false); });
  }, [visible, anim]);

  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [visible]);

  if (!mounted) return null;

  const byKey = new Map((view?.windows ?? []).map((w) => [w.key, w]));
  const rows = WINDOWS.map((m) => ({ meta: m, win: byKey.get(m.key) })).filter((r) => r.win);
  const top = MODAL_TOP_SHIFT + Math.max(insets.top, inset.minTop) + 44;
  // On a tablet the header's content is centred at headerMaxWidth, so the ring
  // sits that much further in from the screen edge than the gutter alone.
  const headerOverflow = Math.max(0, (width - insets.left - insets.right - 32 - headerMaxWidth) / 2);

  // statusBarTranslucent, or Android gives the modal its own window starting *below*
  // the status bar and the scrim stops short of it — the whole app dims except an
  // undimmed strip across the top. It's also what MODAL_TOP_SHIFT compensates for.
  // iOS ignores the prop; its modal is already full-screen.
  return (
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close usage" />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          {
            // Under the header's action row, flush with the gutter the ring sits in.
            top,
            right: 16 + insets.right + headerOverflow,
            width: Math.min(320, width - 32 - insets.left - insets.right),
            // Landscape phones are short: the accounts list scrolls inside the card
            // rather than running off the bottom of the screen.
            maxHeight: height - top - Math.max(insets.bottom, 12) - 12,
            opacity: anim,
            transform: [
              { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
            ],
          },
        ]}
      >
        <ScrollView contentContainerStyle={styles.body} bounces={false}>
          <Text style={styles.title}>Usage</Text>
          {rows.length ? (
            rows.map((r) => <WindowRow key={r.meta.key} win={r.win!} meta={r.meta} now={now} />)
          ) : (
            <Text style={styles.caption}>No usage data right now.</Text>
          )}

          {/* One account has nothing to switch to — the section would be noise. */}
          {accounts.accounts.length > 1 && (
            <View style={styles.accounts}>
              <Text style={styles.title}>Accounts</Text>
              {accounts.accounts.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  usage={accounts.usageById[a.id] ?? null}
                  active={a.id === accounts.activeId}
                  suggested={a.id === suggestedAccountId && a.id !== accounts.activeId}
                  onSwitch={() => { accounts.switchTo(a).then((ok) => { if (ok) onClose(); }); }}
                />
              ))}
            </View>
          )}
          {accounts.loading && <ActivityIndicator color={color.muted} style={styles.accountsSpinner} />}
          {accounts.error && (
            <Pressable onPress={accounts.refresh} hitSlop={8} accessibilityRole="button">
              <Text style={[styles.caption, { color: color.accent }]}>Couldn't load accounts — tap to retry</Text>
            </Pressable>
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(1,4,9,0.5)' },
  panel: {
    position: 'absolute',
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
    // Anchor the growth at the ring's corner rather than the panel's middle, so it
    // reads as unfolding from the thing that was tapped.
    transformOrigin: 'top right',
    ...shadow.menu,
  },
  body: { padding: 14, gap: 14 },
  title: { ...type.fieldLabel, color: color.muted },

  accounts: { gap: 8, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft },
  accountsSpinner: { alignSelf: 'flex-start' },
  account: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10, marginHorizontal: -10,
    borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent',
  },
  // The account the header suggests moving to — lit like a needs-you card.
  accountSuggested: { backgroundColor: tint.fill(color.accent), borderColor: tint.line(color.accent) },
  accountText: { flex: 1, gap: 3 },
  accountName: { ...type.cardTitle, fontSize: 14, flexShrink: 1 },
  suggestedTag: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5, color: color.accent },
  miniTrack: { height: 4, marginTop: 2 },
  activePill: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  activeLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  switchBtn: {
    minHeight: 32, paddingHorizontal: 12, borderRadius: radius.pill, justifyContent: 'center',
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  switchBtnSuggested: { backgroundColor: color.accentDim, borderColor: color.accent },
  switchBtnPressed: { backgroundColor: color.raisedHi },
  switchLabel: { color: color.text, fontSize: 13, fontWeight: '600' },

  row: { gap: 6 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { ...type.cardTitle, fontSize: 15 },
  limitPill: { borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
  limitLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  pct: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },

  track: { height: 6, borderRadius: radius.pill, backgroundColor: color.raised, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },

  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  caption: { ...type.time, color: color.faint },
});
