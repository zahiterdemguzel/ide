// How the phone answers back when you act: a haptic tick, a short toast (with an
// optional Undo), a confirm before anything destructive, and the strip that says the
// desktop is out of reach. Screens call these instead of each inventing their own,
// so "it worked", "are you sure?" and "offline" read the same on every tab.
//
// The toast is driven like ErrorDialog: `showToast(...)` can be called from anywhere,
// and the one <ToastHost/> mounted at the app root is the sink.
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import { color, font, radius, shadow, TAB_BAR_HEIGHT, tint } from '../theme';

// Haptics are a nicety: a device without the hardware (or a dev client built before
// expo-haptics was added) must never turn a tap into an error.
export const haptic = {
  tap: () => { Haptics.selectionAsync().catch(() => {}); },
  success: () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); },
  warning: () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); },
  error: () => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}); },
};

// Ask before doing something that can't be taken back. Resolves true only on the
// confirming button; dismissing the alert (Android back, tapping outside) is a no.
export function confirmAction(
  { title, message, confirmLabel = 'Confirm', destructive = true }:
  { title: string; message?: string; confirmLabel?: string; destructive?: boolean },
): Promise<boolean> {
  haptic.warning();
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export type Toast = {
  message: string;
  tone?: 'success' | 'info' | 'error';
  // An action beside the message — "Undo" after an archive.
  actionLabel?: string;
  onAction?: () => void;
};

const TOAST_MS = 4000;
let toastSink: ((t: Toast) => void) | null = null;

export function showToast(toast: Toast): void {
  if (toast.tone === 'success') haptic.success();
  else if (toast.tone === 'error') haptic.error();
  toastSink?.(toast);
}

// Floats above the tab bar, so it sits clear of the bar on a tab and of the home
// indicator on a pushed screen alike. A newer toast replaces the shown one.
export function ToastHost() {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<Toast | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    toastSink = (t) => {
      setToast(t);
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true })
          .start(() => setToast(null));
      }, TOAST_MS);
    };
    return () => {
      toastSink = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [opacity]);

  if (!toast) return null;
  const hue = toast.tone === 'error' ? color.red : toast.tone === 'success' ? color.green : color.accent;
  const icon = toast.tone === 'error' ? 'alert-circle' : toast.tone === 'success' ? 'checkmark-circle' : 'information-circle';

  const runAction = () => {
    toast.onAction?.();
    setToast(null);
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.toastWrap, { bottom: TAB_BAR_HEIGHT + insets.bottom + 12, opacity }]}
    >
      <View style={styles.toast} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <Ionicons name={icon} size={18} color={hue} />
        <Text style={styles.toastText} numberOfLines={2}>{toast.message}</Text>
        {!!(toast.actionLabel && toast.onAction) && (
          <Pressable onPress={runAction} hitSlop={10} accessibilityRole="button" style={styles.toastAction}>
            <Text style={styles.toastActionText}>{toast.actionLabel}</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

// The strip under a header while the desktop is out of reach. Every tab shows it
// through ScreenHeader, and the pushed screens (Chat, Console) mount it under their
// own bars — without it a dropped link looks exactly like a quiet desktop, and
// stale data reads as current.
export function ConnectionBanner() {
  const { state } = useConnection();
  if (state === 'ready') return null;
  const reconnecting = state === 'connecting' || state === 'pairing';
  const hue = reconnecting ? color.yellow : color.red;
  return (
    <View
      style={[styles.banner, { backgroundColor: tint.fill(hue), borderColor: tint.line(hue) }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={reconnecting ? 'sync' : 'cloud-offline-outline'} size={14} color={hue} />
      <Text style={[styles.bannerText, { color: hue }]} numberOfLines={1}>
        {reconnecting ? 'Reconnecting to the desktop…' : 'Offline — showing the last known state'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 520, alignSelf: 'stretch',
    backgroundColor: color.raised, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border, paddingVertical: 12, paddingHorizontal: 14, ...shadow.menu,
  },
  toastText: { flex: 1, color: color.text, fontSize: font.size.sm },
  toastAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 6 },
  toastActionText: { color: color.accent, fontSize: font.size.sm, fontWeight: '700' },

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 6, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: { flex: 1, fontSize: 12, fontWeight: '600' },
});
