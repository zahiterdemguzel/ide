// The Files tab's viewer/editor: one repo file, syntax-highlighted (CodeView), with
// a pencil that flips it to a plain monospace editor and a Save over `write-text`.
//
// It's a pushed root-stack screen (`FileViewer`), so the tab bar is out of the way
// and back is the platform's own swipe / hardware back. `FilesScreen` falls back to
// rendering <FileViewer inline> inside the tab while that route isn't registered,
// which is why the viewer is a component first and a screen second.
//
// Unsaved edits are never dropped silently: leaving (button, swipe, hardware back)
// asks first, and so does the desktop switching folders under us — saving after
// that would write a repo-relative path into the *new* folder.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, BackHandler, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { UNSTABLE_usePreventRemove, useNavigation, type NavigationAction } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useConnection } from '../api/context';
import { langFor } from '../generated/desktop-assets';
import FileIcon from '../components/FileIcon';
import CodeView, { CODE_SURFACE, CODE_TEXT } from '../components/CodeView';
import { ErrorState, LoadingState } from '../components/ui';
import { ConnectionBanner, confirmAction, showToast } from '../components/feedback';
import { showError, errorText } from '../components/ErrorDialog';
import { openBinaryFile } from '../api/installApk';
import { baseName, parentPath } from '../lib/file-ops';
import { color, font, inset, radius } from '../theme';

// FilesScreen has already read the file (it has to, to tell text from binary before
// pushing anything); it parks the text here so the viewer doesn't fetch it twice.
// Navigation params are the wrong place for a whole file. Consumed on first read.
const preloadedText = new Map<string, string>();
export function primeFileText(path: string, text: string) {
  preloadedText.set(path, text);
}

export type FileViewerParams = { path: string; line?: number };

type Props = FileViewerParams & {
  // Leave unconditionally — the viewer has already asked about unsaved edits.
  onExit: () => void;
  // Inside the Files tab rather than pushed: no stack to guard, so the viewer
  // handles hardware back itself.
  inline?: boolean;
};

export function FileViewer({ path, line, onExit, inline = false }: Props) {
  const { conn } = useConnection();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const name = baseName(path);
  const dir = parentPath(path);

  const [text, setText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Set once leaving has been decided; lifts the unsaved-edits guard so the exit
  // that follows isn't intercepted again.
  const [leaving, setLeaving] = useState(false);
  const pendingAction = useRef<NavigationAction | null>(null);
  // The keyboard offset is where this view's parent starts in the window — 0 for a
  // pushed full-screen route, measured rather than guessed (it used to be a fixed 96).
  const frame = useRef<View>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  const latest = useRef({ text, dirty });
  latest.current = { text, dirty };

  const load = useCallback(async () => {
    if (!conn) return;
    const primed = preloadedText.get(path);
    if (primed !== undefined) {
      preloadedText.delete(path);
      setText(primed);
      return;
    }
    setLoadError(null);
    try {
      const r: any = await conn.req('read-text', path);
      if (r?.ok) { setText(r.text); return; }
      // Not text (an image, a zip…): hand it to the phone's own apps, as the
      // Files tab does, and leave nothing behind.
      setLeaving(true);
      try {
        await openBinaryFile({
          req: (ch, args, opts) => conn.req(ch, args, opts),
          state: () => conn.state,
          onState: (fn) => conn.onState(fn),
        }, path, name);
      } catch (err) {
        showError('Files', `Could not open ${name}.\n\n${errorText(err)}`);
      }
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [conn, path, name]);

  useEffect(() => { load(); }, [load]);

  const confirmDiscard = useCallback(() => confirmAction({
    title: 'Discard changes?',
    message: `${name} has unsaved edits.`,
    confirmLabel: 'Discard',
  }), [name]);

  // Swipe-back, hardware back and the back button all come through here when the
  // viewer is a pushed route. Native-stack also cancels the iOS swipe while this
  // is armed, rather than letting the screen go and asking afterwards.
  UNSTABLE_usePreventRemove(!inline && dirty && !leaving, ({ data }) => {
    confirmDiscard().then((discard) => {
      if (!discard) return;
      pendingAction.current = data.action;
      setLeaving(true);
    });
  });

  useEffect(() => {
    if (!leaving) return;
    if (pendingAction.current) navigation.dispatch(pendingAction.current);
    else onExit();
  }, [leaving, navigation, onExit]);

  const requestExit = useCallback(async () => {
    if (latest.current.dirty && !(await confirmDiscard())) return;
    setLeaving(true);
  }, [confirmDiscard]);

  useEffect(() => {
    if (!inline) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { requestExit(); return true; });
    return () => sub.remove();
  }, [inline, requestExit]);

  // The desktop opened another folder: this path now means a different file (or
  // none). Clean → just go; dirty → offer to keep the edits on the clipboard.
  useEffect(() => conn?.on('folder-changed', () => {
    if (!latest.current.dirty) { setLeaving(true); return; }
    Alert.alert(
      'The desktop switched folders',
      `${name} has unsaved edits, and saving now would write them into the new folder.`,
      [
        { text: 'Discard', style: 'destructive', onPress: () => setLeaving(true) },
        {
          text: 'Copy edits & close',
          onPress: async () => {
            await Clipboard.setStringAsync(latest.current.text ?? '').catch(() => {});
            showToast({ message: `Edits to ${name} copied to the clipboard`, tone: 'info' });
            setLeaving(true);
          },
        },
      ],
      { cancelable: false },
    );
  }), [conn, name]);

  const save = async () => {
    if (!conn || text === null) return;
    setSaving(true);
    try {
      const r: any = await conn.req('write-text', { file: path, text });
      if (!r?.ok) { showError('Save failed', r?.error ?? `Could not save ${name}.`); return; }
      setDirty(false);
      showToast({ message: `Saved ${name}`, tone: 'success' });
    } catch (err) {
      showError('Save failed', `Could not save ${name}.\n\n${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const measureFrame = () => {
    frame.current?.measureInWindow((_x, y) => setKeyboardOffset(Math.max(0, y)));
  };

  return (
    <View ref={frame} style={styles.fill} onLayout={measureFrame}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {/* Measured like every other frame — the design's 54 is an iPhone notch and
            would sit this bar too low on Android. */}
        <View style={[styles.bar, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            onPress={inline ? requestExit : () => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Back to files"
          >
            <Ionicons name="chevron-back" size={22} color={color.accent} />
          </Pressable>
          <FileIcon name={name} size={16} />
          <View style={styles.barTitle}>
            <Text style={styles.fileName} numberOfLines={1}>{name}{dirty ? ' •' : ''}</Text>
            {!!dir && <Text style={styles.filePath} numberOfLines={1}>{dir}</Text>}
          </View>
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
            onPress={() => setEditing((v) => !v)}
            disabled={text === null}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'View highlighted' : 'Edit file'}
          >
            <Ionicons name={editing ? 'eye-outline' : 'create-outline'} size={20} color={color.accent} />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, !dirty && styles.saveBtnOff, pressed && dirty && styles.savePressed]}
            disabled={!dirty || saving}
            onPress={save}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="button"
            accessibilityLabel={dirty ? `Save ${name}` : 'Saved'}
            accessibilityState={{ disabled: !dirty || saving, busy: saving }}
          >
            {saving
              ? <ActivityIndicator size="small" color={color.text} />
              : <Text style={[styles.saveLabel, !dirty && styles.saveLabelOff]}>{dirty ? 'Save' : 'Saved'}</Text>}
          </Pressable>
        </View>
        <ConnectionBanner />

        {loadError ? (
          <ErrorState title={`Couldn't open ${name}`} message={loadError} onRetry={load} />
        ) : text === null ? (
          <LoadingState />
        ) : editing ? (
          <TextInput
            style={styles.editor}
            value={text}
            onChangeText={(v) => { setText(v); setDirty(true); }}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            accessibilityLabel={`Editing ${name}`}
          />
        ) : (
          <CodeView code={text} lang={langFor(name)} line={line} />
        )}
      </KeyboardAvoidingView>
      {/* A pushed screen clears the home indicator itself; outside the keyboard
          view, so the keyboard's overlap isn't counted twice. Inline, the tab bar
          below already does. */}
      {!inline && <View style={{ height: insets.bottom, backgroundColor: CODE_SURFACE }} />}
    </View>
  );
}

export default function FileViewerScreen({ route, navigation }: any) {
  const { path, line } = route.params as FileViewerParams;
  const exit = useCallback(() => navigation.goBack(), [navigation]);
  return <FileViewer path={path} line={line} onExit={exit} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },

  // Compact on purpose — it sits above the file, not above a screen, so it keeps
  // the old chrome rather than a ScreenHeader (a large title would cost the file
  // half its height).
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingBottom: 2,
    gap: 4,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: color.raised },
  barTitle: { flex: 1, minWidth: 0 },
  fileName: { color: color.text, fontSize: 14, fontWeight: '600' },
  filePath: { color: color.faint, fontSize: 11 },
  saveBtn: {
    minWidth: 66,
    height: 36,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.md,
    backgroundColor: color.greenDeep,
  },
  saveBtnOff: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  savePressed: { backgroundColor: color.green },
  saveLabel: { color: color.text, fontSize: 13, fontWeight: '600' },
  saveLabelOff: { color: color.faint },

  // The editor keeps CodeView's own surface: the two swap in place, and a GitHub-dark
  // TextInput behind VS-Code-themed syntax would make editing look like a different file.
  editor: {
    flex: 1,
    color: CODE_TEXT,
    backgroundColor: CODE_SURFACE,
    fontFamily: font.mono,
    fontSize: 13,
    lineHeight: 19,
    padding: 12,
  },
});
