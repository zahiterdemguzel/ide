// A unified diff drawn the way the desktop's diff dialog reads: one card per file
// (name, +/− counts), its hunks below as numbered rows on a green/red wash. Shared by
// Git (a file's diff), History (a commit's), stash, and the chat's session diff.
//
// Rows are virtualised (FlatList) because a commit or a Write can be thousands of
// lines; mapping them all into a ScrollView froze the JS thread on big patches.
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { parseUnifiedDiff, type DiffFile, type DiffRow } from '../lib/diff-parse';
import { color, font, radius, tint } from '../theme';
import FileIcon from './FileIcon';

type Item =
  | { t: 'file'; key: string; file: DiffFile; open: boolean }
  | { t: 'row'; key: string; row: DiffRow }
  | { t: 'note'; key: string; text: string };

// Past this many files a patch opens collapsed, so it starts as a list of names.
const AUTO_COLLAPSE_FILES = 6;

export default function DiffView(
  { patch, emptyLabel = 'No changes', header }:
  { patch: string; emptyLabel?: string; header?: React.ReactElement },
) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [closed, setClosed] = useState<Set<string> | null>(null);
  const isClosed = (path: string) =>
    closed ? closed.has(path) : files.length > AUTO_COLLAPSE_FILES;

  const toggle = (path: string) => {
    setClosed((prev) => {
      const next = new Set(prev ?? (files.length > AUTO_COLLAPSE_FILES ? files.map((f) => f.path) : []));
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const items = useMemo(() => {
    const out: Item[] = [];
    files.forEach((file, fi) => {
      const open = !isClosed(file.path);
      out.push({ t: 'file', key: `f${fi}`, file, open });
      if (!open) return;
      if (file.binary) out.push({ t: 'note', key: `b${fi}`, text: 'Binary file — not shown' });
      else if (!file.rows.length) out.push({ t: 'note', key: `e${fi}`, text: 'No content changes (mode or rename only)' });
      file.rows.forEach((row, ri) => out.push({ t: 'row', key: `r${fi}-${ri}`, row }));
    });
    return out;
  }, [files, closed]);

  if (!files.length) {
    return (
      <View style={styles.empty}>
        {header}
        <Text style={styles.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(it) => it.key}
      ListHeaderComponent={header}
      initialNumToRender={60}
      maxToRenderPerBatch={80}
      windowSize={11}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        if (item.t === 'file') return <FileHead file={item.file} open={item.open} onPress={() => toggle(item.file.path)} />;
        if (item.t === 'note') return <Text style={styles.note}>{item.text}</Text>;
        return <Row row={item.row} />;
      }}
    />
  );
}

function FileHead({ file, open, onPress }: { file: DiffFile; open: boolean; onPress: () => void }) {
  const name = file.path.split('/').pop() || file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.fileHead, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${file.path}, ${file.additions} added, ${file.deletions} removed`}
    >
      <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={color.muted} />
      <FileIcon name={name} size={16} />
      <Text style={styles.fileName} numberOfLines={1}>
        {!!dir && <Text style={styles.fileDir}>{dir}</Text>}
        {name}
      </Text>
      {file.additions > 0 && <Text style={styles.adds}>+{file.additions}</Text>}
      {file.deletions > 0 && <Text style={styles.dels}>−{file.deletions}</Text>}
    </Pressable>
  );
}

function Row({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk') return <Text style={styles.hunk} numberOfLines={1}>{row.text}</Text>;
  const n = row.kind === 'del' ? row.oldLine : row.newLine;
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  return (
    // Horizontal scroll per row keeps long lines readable without wrapping the code.
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[
      row.kind === 'add' && styles.addRow,
      row.kind === 'del' && styles.delRow,
    ]}>
      <Text style={[styles.code, row.kind === 'add' && styles.addText, row.kind === 'del' && styles.delText, row.kind === 'meta' && styles.metaText]}>
        <Text style={styles.lineNo}>{n != null ? String(n).padStart(4, ' ') : '    '} </Text>
        {sign} {row.text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 24 },
  empty: { flex: 1 },
  emptyText: { color: color.muted, textAlign: 'center', padding: 24, fontSize: font.size.sm },
  pressed: { backgroundColor: color.raised },
  fileHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44,
    paddingHorizontal: 12, backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderSoft, borderRadius: radius.sm,
  },
  fileName: { flex: 1, color: color.body, fontSize: font.size.sm, fontWeight: '600' },
  fileDir: { color: color.faint, fontWeight: '400' },
  adds: { color: color.green, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  dels: { color: color.red, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  note: { color: color.faint, fontSize: 12, fontStyle: 'italic', paddingHorizontal: 12, paddingVertical: 8 },
  hunk: {
    color: color.accent, backgroundColor: tint.fill(color.accent), fontFamily: font.mono,
    fontSize: 11, paddingHorizontal: 8, paddingVertical: 3,
  },
  code: { color: color.body, fontFamily: font.mono, fontSize: 12, lineHeight: 18, paddingRight: 12 },
  lineNo: { color: color.faint },
  addRow: { backgroundColor: tint.fill(color.green) },
  delRow: { backgroundColor: tint.fill(color.red) },
  addText: { color: color.greenSoft },
  delText: { color: color.redSoft },
  metaText: { color: color.faint, fontStyle: 'italic' },
});
