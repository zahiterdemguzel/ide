// Stashes for the Git tab: set the working tree aside, list what's been set aside,
// look at one, and apply / pop / drop it. Mirrors the desktop's Stashes section
// (src/renderer/git-pane.js) and main's git-stash-* channels.
//
// Viewing a stash swaps the sheet's content for its diff rather than opening a second
// Modal (see GitSheets.tsx). Every mutation closes the sheet first and then runs: its
// result is a toast or an error dialog, and neither can show over an open Modal.
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useConnection } from '../api/context';
import { stashPushOutcome } from '../lib/git-actions';
import DiffView from './DiffView';
import { showError } from './ErrorDialog';
import { confirmAction, haptic, showToast } from './feedback';
import { Sheet } from './GitSheets';
import { Button, EmptyState, ErrorState, IconButton, LoadingState } from './ui';
import { color, font } from '../theme';

type Stash = { ref: string; message: string; relDate: string };
type Res = { ok: boolean; stdout?: string; stderr?: string };

export default function StashSheet({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  // The working tree (and possibly the log) moved — refetch git status.
  onChanged: () => void;
}) {
  const { conn } = useConnection();
  const [stashes, setStashes] = useState<Stash[] | null>(null);
  const [listError, setListError] = useState('');
  const [viewing, setViewing] = useState<Stash | null>(null);
  const [patch, setPatch] = useState('');
  const [patchState, setPatchState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadList = useCallback(async () => {
    if (!conn) return;
    setListError('');
    try {
      const r = await conn.req<{ ok: boolean; error?: string; stashes: Stash[] }>('git-stash-list');
      if (r?.ok === false) setListError(r.error || 'git stash list failed');
      setStashes(r?.stashes ?? []);
    } catch (e: any) {
      setListError(String(e?.message ?? e));
      setStashes([]);
    }
  }, [conn]);

  useEffect(() => {
    if (!open) return;
    setStashes(null);
    setViewing(null);
    loadList();
  }, [open, loadList]);

  // A stash's patch, fetched when it's opened. A superseded fetch is dropped.
  useEffect(() => {
    if (!viewing || !conn) return;
    let cancelled = false;
    setPatchState('loading');
    conn.req<Res>('git-stash-show', viewing.ref)
      .then((r) => {
        if (cancelled) return;
        if (r?.ok) { setPatch(r.stdout || ''); setPatchState('ready'); }
        else { setPatch(r?.stderr || 'Could not load the stash.'); setPatchState('error'); }
      })
      .catch((e) => { if (!cancelled) { setPatch(String(e?.message ?? e)); setPatchState('error'); } });
    return () => { cancelled = true; };
  }, [viewing, conn]);

  const run = async (label: string, success: string, fn: () => Promise<Res>) => {
    onClose();
    try {
      const r = await fn();
      if (r && r.ok === false) showError(label, r.stderr || `${label} failed`);
      else showToast({ message: success, tone: 'success' });
    } catch (e: any) {
      showError(label, e);
    }
    onChanged();
  };

  const push = async () => {
    haptic.tap();
    onClose();
    try {
      const r = await conn!.req<Res>('git-stash-push');
      const outcome = stashPushOutcome(r);
      if (outcome === 'failed') showError('Stash', r?.stderr || 'Stash failed');
      else showToast({ message: outcome === 'nothing' ? 'Nothing to stash' : 'Changes stashed', tone: outcome === 'nothing' ? 'info' : 'success' });
    } catch (e: any) {
      showError('Stash', e);
    }
    onChanged();
  };

  const apply = (s: Stash) => run('Apply stash', `Applied ${s.ref}`, () => conn!.req<Res>('git-stash-apply', s.ref));
  const pop = (s: Stash) => run('Pop stash', `Popped ${s.ref}`, () => conn!.req<Res>('git-stash-pop', s.ref));
  const drop = async (s: Stash) => {
    const ok = await confirmAction({
      title: 'Drop this stash?',
      message: `“${s.message}” is deleted without being applied. This can't be undone.`,
      confirmLabel: 'Drop',
    });
    if (ok) run('Drop stash', `Dropped ${s.ref}`, () => conn!.req<Res>('git-stash-drop', s.ref));
  };

  if (viewing) {
    return (
      <Sheet open={open} onClose={onClose} title={viewing.message} subtitle={`${viewing.ref} · ${viewing.relDate}`} tall>
        <Pressable
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
          onPress={() => setViewing(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to stashes"
        >
          <Ionicons name="chevron-back" size={16} color={color.accent} />
          <Text style={styles.backLabel}>Stashes</Text>
        </Pressable>
        <View style={styles.fill}>
          {patchState === 'loading'
            ? <LoadingState label="Loading stash…" />
            : patchState === 'error'
              ? <ErrorState title="Couldn't load the stash" message={patch} />
              : <DiffView patch={patch} emptyLabel="This stash has no changes" />}
        </View>
        <View style={styles.footer}>
          <Button label="Apply" icon="copy-outline" tone="secondary" onPress={() => apply(viewing)} style={styles.fill} />
          <Button label="Pop" icon="download-outline" onPress={() => pop(viewing)} style={styles.fill} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Stashes" tall>
      <View style={styles.pushRow}>
        <Button label="Stash all changes" icon="archive-outline" tone="secondary" onPress={push} />
        <Text style={styles.pushHint}>Includes untracked files.</Text>
      </View>
      <View style={styles.fill}>
        {stashes === null
          ? <LoadingState />
          : listError && !stashes.length
            ? <ErrorState message={listError} onRetry={loadList} />
            : (
              <FlatList
                data={stashes}
                keyExtractor={(s) => s.ref}
                contentContainerStyle={!stashes.length && styles.grow}
                ListEmptyComponent={
                  <EmptyState icon="archive-outline" title="No stashes" message="Stashed changes show up here." />
                }
                renderItem={({ item }) => (
                  <Pressable
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    onPress={() => setViewing(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.message}, ${item.relDate}. Show changes`}
                  >
                    <View style={styles.rowMain}>
                      <Text style={styles.subject} numberOfLines={1}>{item.message}</Text>
                      <Text style={styles.meta} numberOfLines={1}>{item.ref} · {item.relDate}</Text>
                    </View>
                    <IconButton icon="copy-outline" label={`Apply ${item.ref} and keep it`} size={17} onPress={() => apply(item)} style={styles.rowBtn} />
                    <IconButton icon="download-outline" label={`Pop ${item.ref}: apply and remove it`} size={17} onPress={() => pop(item)} style={styles.rowBtn} />
                    <IconButton icon="trash-outline" label={`Drop ${item.ref}`} hue={color.red} size={17} onPress={() => drop(item)} style={styles.rowBtn} />
                  </Pressable>
                )}
              />
            )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
  pressed: { backgroundColor: color.raised },
  pushRow: { padding: 16, gap: 6 },
  pushHint: { color: color.faint, fontSize: 12, textAlign: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 56,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft,
  },
  rowMain: { flex: 1, minWidth: 0 },
  subject: { color: color.text, fontSize: font.size.sm + 1 },
  meta: { color: color.muted, fontSize: 11, marginTop: 2 },
  // 36 + IconButton's 6pt hitSlop each side = 48pt touch target.
  rowBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  back: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44,
    paddingHorizontal: 12, alignSelf: 'flex-start',
  },
  backLabel: { color: color.accent, fontSize: 14, fontWeight: '600' },
  footer: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft,
  },
});
