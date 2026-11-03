// The bottom sheets the Git tab is built from: one `Sheet` frame (scrim, keyboard
// avoidance, the bottom inset), a list of actions to put in it, and a one-field
// prompt. A flow that needs a menu *then* a name (History's "Create branch here…")
// swaps the sheet's content in place rather than opening a second Modal: on iOS a
// Modal can't be presented while another one is still dismissing, so stacking them
// silently drops the second.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button, IconButton } from './ui';
import { color, font, inset, MODAL_TOP_SHIFT, radius } from '../theme';

// Opening one sheet from another (the ⋯ menu's "Stashes…", a commit menu's "View
// changes") has to wait for the first to finish sliding away on iOS, or the second
// Modal never appears. `schedule` defers to the closing sheet's `onDismiss` there;
// Android has no such conflict (and no reliable onDismiss), so it runs at once.
export function useAfterDismiss() {
  const pending = useRef<(() => void) | null>(null);
  const schedule = useCallback((fn: () => void) => {
    if (Platform.OS === 'ios') pending.current = fn;
    else fn();
  }, []);
  const onDismiss = useCallback(() => {
    const fn = pending.current;
    pending.current = null;
    fn?.();
  }, []);
  return { schedule, onDismiss };
}

export function Sheet({ open, onClose, onDismiss, title, subtitle, tall, children }: {
  open: boolean;
  onClose: () => void;
  // Runs once the sheet has finished closing (iOS) — see useAfterDismiss.
  onDismiss?: () => void;
  title: string;
  subtitle?: string;
  // A tall sheet fills the screen down from just under the status bar (a diff, a
  // list that grows); a short one hugs its content up to 75%.
  tall?: boolean;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const top = Math.max(insets.top, inset.minTop) + MODAL_TOP_SHIFT + 8;
  return (
    <Modal
      visible={open}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <View
          style={[
            styles.sheet,
            tall ? { top } : styles.short,
            { paddingBottom: insets.bottom + 8 },
          ]}
        >
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.title} numberOfLines={1} accessibilityRole="header">{title}</Text>
              {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
            </View>
            <IconButton icon="close" label="Close" size={20} onPress={onClose} style={styles.close} />
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type SheetAction = {
  key: string;
  label: string;
  icon: any;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

// Scrolls when a long menu outgrows a short sheet's 75% cap on a small phone.
export function ActionList({ actions }: { actions: SheetAction[] }) {
  return (
    <ScrollView style={styles.actionScroll} bounces={false}>
      {actions.map((a) => {
        const hue = a.disabled ? color.faint : a.destructive ? color.red : color.text;
        return (
          <Pressable
            key={a.key}
            style={({ pressed }) => [styles.action, pressed && !a.disabled && styles.pressed]}
            onPress={a.onPress}
            disabled={a.disabled}
            accessibilityRole="button"
            accessibilityLabel={a.hint ? `${a.label}. ${a.hint}` : a.label}
            accessibilityState={{ disabled: !!a.disabled }}
          >
            <Ionicons name={a.icon} size={18} color={a.destructive && !a.disabled ? color.red : color.muted} />
            <View style={styles.actionText}>
              <Text style={[styles.actionLabel, { color: hue }]} numberOfLines={1}>{a.label}</Text>
              {!!a.hint && <Text style={styles.actionHint} numberOfLines={2}>{a.hint}</Text>}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// One text field and a confirm button — the phone's stand-in for the desktop's
// promptText (Alert.prompt is iOS-only). `normalize` previews what will actually be
// used (a branch name with its spaces hyphenated) so the button never lies.
export function PromptForm({ label, placeholder, confirmLabel, onSubmit, normalize }: {
  label: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  normalize?: (raw: string) => string;
}) {
  const [value, setValue] = useState('');
  useEffect(() => setValue(''), [label]);
  const final = normalize ? normalize(value) : value.trim();
  const submit = () => { if (final) onSubmit(final); };
  return (
    <View style={styles.prompt}>
      <Text style={styles.promptLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={color.faint}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        accessibilityLabel={label}
      />
      {!!normalize && !!final && final !== value.trim() && (
        <Text style={styles.promptPreview} numberOfLines={1}>Will be “{final}”</Text>
      )}
      <Button label={confirmLabel} onPress={submit} disabled={!final} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000a' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: color.bg, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.border,
  },
  short: { maxHeight: '75%' },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft,
  },
  headText: { flex: 1, minWidth: 0 },
  title: { color: color.text, fontSize: 16, fontWeight: '700' },
  subtitle: { color: color.muted, fontSize: 12, marginTop: 2 },
  // 32 visual + IconButton's hitSlop of 6 clears the 44pt floor.
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: color.raised },

  actionScroll: { flexGrow: 0, flexShrink: 1 },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    minHeight: 52, paddingHorizontal: 18, paddingVertical: 8,
  },
  actionText: { flex: 1, minWidth: 0 },
  actionLabel: { fontSize: font.size.md },
  actionHint: { color: color.faint, fontSize: 12, marginTop: 2 },

  prompt: { padding: 16, gap: 10 },
  promptLabel: { color: color.muted, fontSize: 13, fontWeight: '600' },
  promptPreview: { color: color.faint, fontSize: 12 },
  input: {
    color: color.text, backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
});
