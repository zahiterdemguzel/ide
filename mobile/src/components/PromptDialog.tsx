// Two small overlays the Files tab and the Run panel need and RN doesn't ship
// cross-platform: a one-field text prompt (`Alert.prompt` is iOS-only) and a
// bottom action sheet (an Android `Alert` caps out at three oddly-ordered buttons).
//
// Both are scrim Modals, so both set `statusBarTranslucent` (see mobile-design.md,
// "Darkening the screen"). The sheet is bottom-anchored, so it needs no
// MODAL_TOP_SHIFT, but it does clear the home indicator itself.
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { color, font, radius, shadow } from '../theme';

const SCRIM = 'rgba(1, 4, 9, 0.6)';
const SHEET_DISMISS_MS = Platform.OS === 'ios' ? 350 : 0;

export type PromptRequest = {
  title: string;
  // The line under the title — where the entry will land, say.
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  // Returns an error to show under the field (the dialog stays open, as the
  // desktop's prompt re-asks on failure), or null to close.
  onSubmit: (value: string) => Promise<string | null> | string | null;
};

export function PromptDialog({ request, onClose }: { request: PromptRequest | null; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!request) return;
    setValue(request.initialValue ?? '');
    setError(null);
    setSubmitting(false);
  }, [request]);

  const submit = async () => {
    if (!request || submitting) return;
    setSubmitting(true);
    try {
      const problem = await request.onSubmit(value);
      if (problem) setError(problem);
      else onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={!!request} transparent statusBarTranslucent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.center} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Dismiss" />
        {request && (
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.title}>{request.title}</Text>
            {!!request.message && <Text style={styles.message}>{request.message}</Text>}
            <TextInput
              style={[styles.input, !!error && styles.inputError]}
              value={value}
              onChangeText={(v) => { setValue(v); setError(null); }}
              placeholder={request.placeholder}
              placeholderTextColor={color.faint}
              autoFocus
              selectTextOnFocus
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              onSubmitEditing={submit}
              accessibilityLabel={request.title}
            />
            {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
            <View style={styles.buttons}>
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                onPress={onClose}
                accessibilityRole="button"
              >
                <Text style={styles.cancelLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.button, styles.confirm, pressed && styles.confirmPressed]}
                onPress={submit}
                disabled={submitting}
                accessibilityRole="button"
              >
                {submitting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.confirmLabel}>{request.confirmLabel ?? 'OK'}</Text>}
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type SheetAction = {
  label: string;
  icon: any;
  destructive?: boolean;
  onPress: () => void;
};

export function ActionSheet(
  { title, actions, onClose }: { title?: string; actions: SheetAction[] | null; onClose: () => void },
) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!actions} transparent statusBarTranslucent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Dismiss" />
      <View style={[styles.sheet, { paddingBottom: 8 + insets.bottom }]} accessibilityViewIsModal>
        {!!title && <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>}
        {(actions ?? []).map((a) => {
          const hue = a.destructive ? color.red : color.text;
          return (
            <Pressable
              key={a.label}
              style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
              // Close first, then act: iOS won't present an Alert or another Modal
              // while this one is still animating out, so the action waits for it.
              onPress={() => { onClose(); setTimeout(a.onPress, SHEET_DISMISS_MS); }}
              accessibilityRole="button"
              accessibilityLabel={a.label}
            >
              <Ionicons name={a.icon} size={20} color={a.destructive ? color.red : color.muted} />
              <Text style={[styles.sheetLabel, { color: hue }]}>{a.label}</Text>
            </Pressable>
          );
        })}
        <Pressable
          style={({ pressed }) => [styles.sheetRow, styles.sheetCancel, pressed && styles.sheetRowPressed]}
          onPress={onClose}
          accessibilityRole="button"
        >
          <Text style={[styles.sheetLabel, styles.sheetCancelLabel]}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: SCRIM },
  dialog: {
    alignSelf: 'stretch', maxWidth: 420, width: '100%', alignItems: 'stretch',
    backgroundColor: color.surface, borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.border,
    padding: 18, gap: 10, ...shadow.menu,
  },
  title: { color: color.text, fontSize: font.size.lg, fontWeight: '700' },
  message: { color: color.muted, fontSize: font.size.sm, lineHeight: 18 },
  input: {
    color: color.text, fontSize: font.size.md, fontFamily: font.mono,
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border, borderRadius: radius.md,
    paddingHorizontal: 12, minHeight: 44, marginTop: 4,
  },
  inputError: { borderColor: color.red },
  error: { color: color.redSoft, fontSize: 12, lineHeight: 17 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  button: {
    minHeight: 44, minWidth: 88, paddingHorizontal: 16, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonPressed: { backgroundColor: color.raised },
  confirm: { backgroundColor: color.greenDeep },
  confirmPressed: { opacity: 0.85 },
  cancelLabel: { color: color.muted, fontSize: font.size.md, fontWeight: '600' },
  confirmLabel: { color: '#fff', fontSize: font.size.md, fontWeight: '600' },

  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: color.surface, borderTopLeftRadius: radius.card, borderTopRightRadius: radius.card,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.border, paddingTop: 8,
  },
  sheetTitle: {
    color: color.muted, fontSize: 12, fontWeight: '600',
    paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8,
  },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 20 },
  sheetRowPressed: { backgroundColor: color.raised },
  sheetLabel: { fontSize: font.size.md, fontWeight: '500' },
  sheetCancel: { justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.borderSoft, marginTop: 4 },
  sheetCancelLabel: { color: color.muted, fontWeight: '600' },
});
