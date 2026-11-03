// A full-height sheet showing one patch through DiffView — a changed file's diff, a
// commit's, a stash's. The caller fetches; this draws the three states (loading,
// failed, the patch) and an optional row of actions pinned under the diff, above
// the home indicator.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import DiffView from './DiffView';
import { Sheet } from './GitSheets';
import { Button, ErrorState, LoadingState } from './ui';
import { color } from '../theme';

export type DiffSheetAction = {
  label: string;
  icon?: any;
  onPress: () => void;
  // Primary is the green create/commit fill; secondary is raised grey; danger is
  // red-filled for a discard.
  tone?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
};

export default function DiffSheet({
  open, title, subtitle, patch, loading, error, emptyLabel, actions, onClose, onRetry,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  patch: string;
  loading: boolean;
  error?: string;
  emptyLabel?: string;
  actions?: DiffSheetAction[];
  onClose: () => void;
  onRetry?: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle} tall>
      <View style={styles.body}>
        {loading
          ? <LoadingState label="Loading diff…" />
          : error
            ? <ErrorState title="Couldn't load the diff" message={error} onRetry={onRetry} />
            : <DiffView patch={patch} emptyLabel={emptyLabel} />}
      </View>
      {!!actions?.length && (
        <View style={styles.actions}>
          {actions.map((a) => (
            <Button
              key={a.label}
              label={a.label}
              icon={a.icon}
              onPress={a.onPress}
              disabled={a.disabled || loading}
              tone={a.tone === 'secondary' ? 'secondary' : 'primary'}
              hue={a.tone === 'danger' ? color.red : color.greenDeep}
              style={styles.action}
            />
          ))}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  actions: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.borderSoft,
  },
  action: { flex: 1 },
});
