// A file opened from a chat link: read-only, stacked over the chat so back returns
// to the conversation (the Files tab would replace it). Same compact bar and the
// same viewer as the Files tab, scrolled to the line the link named.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useConnection } from '../api/context';
import { langFor } from '../generated/desktop-assets';
import FileIcon from '../components/FileIcon';
import CodeView from '../components/CodeView';
import { showError, errorText } from '../components/ErrorDialog';
import { openBinaryFile } from '../api/installApk';
import { color, radius, inset } from '../theme';

export default function FileScreen({ route, navigation }: any) {
  const { path, line } = route.params as { path: string; line?: number };
  const { conn } = useConnection();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState<string | null>(null);
  const name = path.split('/').pop()!;
  const dir = path.split('/').slice(0, -1).join('/');

  useEffect(() => {
    if (!conn) return;
    let live = true;
    (async () => {
      const r: any = await conn.req('read-text', path).catch(() => null);
      if (!live) return;
      if (r?.ok) { setText(r.text); return; }
      // Not text (an image, a PDF…): hand it to the phone's own apps, as the Files
      // tab does, and leave nothing behind on the stack.
      navigation.goBack();
      try {
        await openBinaryFile({
          req: (ch, args, opts) => conn.req(ch, args, opts),
          state: () => conn.state,
          onState: (fn) => conn.onState(fn),
        }, path, name);
      } catch (err) {
        showError('Open file', `Could not open ${name}.\n\n${errorText(err)}`);
      }
    })();
    return () => { live = false; };
  }, [conn, path, name, navigation]);

  return (
    <View style={styles.fill}>
      <View style={[styles.bar, { paddingTop: Math.max(insets.top, inset.minTop) }]}>
        <Pressable style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]} hitSlop={8} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={20} color={color.accent} />
        </Pressable>
        <FileIcon name={name} size={16} />
        <View style={styles.barTitle}>
          <Text style={styles.fileName} numberOfLines={1}>{name}{line ? `:${line}` : ''}</Text>
          {!!dir && <Text style={styles.filePath} numberOfLines={1}>{dir}</Text>}
        </View>
      </View>
      {text === null
        ? <View style={styles.center}><ActivityIndicator color={color.accent} /></View>
        : <CodeView code={text} lang={langFor(name)} line={line} />}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 6,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  pressed: { backgroundColor: color.raised },
  barTitle: { flex: 1, minWidth: 0 },
  fileName: { color: color.text, fontSize: 14, fontWeight: '600' },
  filePath: { color: color.faint, fontSize: 11 },
});
