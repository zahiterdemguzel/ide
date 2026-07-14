// Scan the ide://pair QR shown in the desktop's Settings → Remote access.
import React, { useState } from 'react';
import { View, Text, Button, StyleSheet } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parsePairUrl } from '../api/pairing';
import { useConnection } from '../api/context';

export default function PairScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const { pair, state } = useConnection();

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera access is needed to scan the pairing QR code.</Text>
        <Button title="Grant camera access" onPress={requestPermission} />
      </View>
    );
  }

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
      <View style={styles.overlay}>
        <Text style={styles.text}>
          {state === 'error' ? 'Pairing failed — get a new code on the desktop and rescan.'
            : scanned ? 'Connecting…'
            : error ?? 'Open Settings → Remote access on the desktop IDE and scan its QR code.'}
        </Text>
        {(error || state === 'error') && <Button title="Scan again" onPress={() => { setScanned(false); setError(null); }} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  overlay: { position: 'absolute', bottom: 40, left: 20, right: 20, alignItems: 'center', gap: 8 },
  text: { color: '#fff', textAlign: 'center', backgroundColor: '#0008', padding: 8, borderRadius: 6 },
});
