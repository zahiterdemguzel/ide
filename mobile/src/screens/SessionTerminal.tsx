// Live terminal for one Claude session. xterm.js can't run in React Native, so
// it renders inside a WebView (xterm from CDN — the phone has internet even
// when the desktop link is LAN). pty-data events stream in; keystrokes go back
// over the `pty-input` send channel — same wire format the desktop renderer uses.
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import { useConnection } from '../api/context';

const TERMINAL_HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>html,body{margin:0;height:100%;background:#1e1e1e}#t{height:100%}</style>
</head><body><div id="t"></div><script>
  const term = new Terminal({ fontSize: 12, theme: { background: '#1e1e1e' }, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  fit.fit();
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  term.onData((data) => post({ t: 'input', data }));
  window.addEventListener('resize', () => { fit.fit(); post({ t: 'resize', cols: term.cols, rows: term.rows }); });
  post({ t: 'resize', cols: term.cols, rows: term.rows });
  // RN injects output via window.__write(base64) — base64 survives quoting.
  window.__write = (b64) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
</script></body></html>`;

// btoa that survives non-Latin1 (PTY output is UTF-8 text).
function toBase64(s: string): string {
  const bytes = unescape(encodeURIComponent(s));
  // global btoa exists in RN's JSC/Hermes via polyfill on modern Expo
  return global.btoa ? global.btoa(bytes) : Buffer.from(bytes, 'binary').toString('base64');
}

export default function SessionTerminal({ route }: any) {
  const { id } = route.params as { id: string };
  const { conn } = useConnection();
  const webRef = useRef<WebView>(null);
  const buffered = useRef<string[]>([]);
  const ready = useRef(false);

  useEffect(() => {
    const off = conn?.on('pty-data', (p: any) => {
      if (p.id !== id) return;
      const b64 = toBase64(p.data);
      if (!ready.current) { buffered.current.push(b64); return; }
      webRef.current?.injectJavaScript(`window.__write("${b64}"); true;`);
    });
    return off;
  }, [conn, id]);

  return (
    <View style={styles.fill}>
      <WebView
        ref={webRef}
        source={{ html: TERMINAL_HTML, baseUrl: Platform.OS === 'android' ? 'https://localhost' : undefined }}
        originWhitelist={['*']}
        onMessage={(e) => {
          const msg = JSON.parse(e.nativeEvent.data);
          if (msg.t === 'input') conn?.send('pty-input', { id, data: msg.data });
          if (msg.t === 'resize') {
            conn?.send('pty-resize', { id, cols: msg.cols, rows: msg.rows });
            if (!ready.current) {
              ready.current = true;
              for (const b64 of buffered.current) webRef.current?.injectJavaScript(`window.__write("${b64}"); true;`);
              buffered.current = [];
            }
          }
        }}
        style={styles.fill}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#1e1e1e' } });
