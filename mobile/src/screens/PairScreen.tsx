// Scan the ide://pair QR shown in the desktop's Settings → Remote access.
import React, { useState } from 'react';
import { View, Text, StyleSheet, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parsePairUrl } from '../api/pairing';
import { useConnection } from '../api/context';
import { Button, EmptyState } from '../components/ui';
import { alpha, color, radius } from '../theme';

export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const { pair, state } = useConnection();

  if (!permission?.granted) {
    // Once the user has said no (or the OS won't ask again), requesting again is a
    // silent no-op — the only way forward is the app's page in system Settings.
    const blocked = !!permission && !permission.canAskAgain;
    return (
      <View style={styles.center}>
        <EmptyState
          icon="camera-outline"
          title="Camera access needed"
          message={blocked
            ? 'Camera access is turned off for this app. Turn it on in Settings to scan the pairing QR code.'
            : 'The camera is only used to scan the pairing QR code shown on the desktop.'}
          actionLabel={blocked ? 'Open Settings' : 'Allow camera'}
          actionIcon={blocked ? 'settings-outline' : 'camera'}
          onAction={blocked ? () => { Linking.openSettings(); } : requestPermission}
        />
      </View>
    );
  }

  const failed = state === 'error';
  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : ({ data }) => {
          const info = parsePairUrl(data);
          if (!info) { setError('Not an IDE pairing code.'); return; }
          setScanned(true);
          setError(null);
          pair(info);
        }}
      />
      {/* Clears the home indicator by the device's own number (0 on Android, which
          isn't edge-to-edge — see mobile-design.md, "The bottom edge"). */}
      <View style={[styles.overlay, { bottom: insets.bottom + 24 }]}>
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {failed ? 'Pairing failed — get a new code on the desktop and rescan.'
            : scanned ? 'Connecting…'
              : error ?? 'Open Settings → Remote access on the desktop IDE and scan its QR code.'}
        </Text>
        {(error || failed) && (
          <Button
            label="Scan again"
            icon="scan-outline"
            onPress={() => { setScanned(false); setError(null); }}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: color.bg },
  overlay: { position: 'absolute', left: 20, right: 20, alignItems: 'center', gap: 10 },
  text: {
    color: color.text, textAlign: 'center', backgroundColor: alpha(color.bg, 0.8),
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm, overflow: 'hidden',
  },
});
