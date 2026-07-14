// The terminal itself, shared by the Claude-session screen and the run-terminal
// screen. xterm.js can't run in React Native, so it renders inside a WebView
// (xterm from CDN — the phone has internet even when the desktop link is LAN).
// The parent owns the wire: it feeds output in via the ref's write(), and gets
// keystrokes/resizes back as callbacks.
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

// xterm stacks .xterm-screen ON TOP of the scrollable .xterm-viewport, so a drag
// over the terminal body never reaches the scroll container and the phone is stuck
// at the bottom of the scrollback. We drive the viewport's scrollTop from the touch
// instead — see the scrolling block below for why it's done this way.
const TERMINAL_HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#1e1e1e;overscroll-behavior:none}
  /* We own the gesture: no browser panning to compete with (and no 300ms wait to
     find out whether it wanted to). */
  #t{height:100%;touch-action:none}
  /* Select mode: a plain read-only copy of the buffer, laid over the terminal.
     Trying to select xterm's own DOM does not work — it sets user-select:none and
     its pointer handlers preventDefault to drive its own mouse selection, so the
     platform's long-press never starts. Ordinary text in a plain element has none
     of that, so native handles, the magnifier and the system Copy menu all behave. */
  #sel{
    display:none;position:absolute;inset:0;overflow:auto;
    margin:0;padding:4px;box-sizing:border-box;
    background:#1e1e1e;color:#ccc;
    font:12px/1.2 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-word;
    touch-action:pan-y;
    user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;
  }
  body.sel #sel{display:block}
</style>
</head><body><div id="t"></div><pre id="sel"></pre><script>
  const term = new Terminal({ fontSize: 12, theme: { background: '#1e1e1e' }, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const host = document.getElementById('t');
  term.open(host);
  fit.fit();
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  term.onData((data) => post({ t: 'input', data }));
  window.addEventListener('resize', () => { fit.fit(); post({ t: 'resize', cols: term.cols, rows: term.rows }); });
  post({ t: 'resize', cols: term.cols, rows: term.rows });
  // RN injects output via window.__write(base64) — base64 survives quoting.
  window.__write = (b64) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

  // --- Select & copy ---------------------------------------------------------
  // Select mode swaps in #sel: the same text, as plain selectable DOM. Selecting
  // xterm's own output is a dead end — it sets user-select:none and its pointer
  // handlers preventDefault to run its own mouse selection, so a long-press never
  // reaches the platform's selection gesture. Copying the text out into an
  // ordinary <pre> sidesteps all of it, and brings native scrolling with it.
  const sel = document.getElementById('sel');
  const bufferText = () => {
    const b = term.buffer.active, out = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return out.join('\\n').replace(/\\s+$/, '');
  };
  // The overlay is a snapshot taken when select mode opens. Live output keeps
  // landing in the terminal underneath, but re-rendering #sel as it arrives would
  // blow away a selection mid-drag — so it stays still until you leave the mode.
  let selecting = false;
  window.__setSelect = (on) => {
    selecting = on;
    document.body.classList.toggle('sel', on);
    if (on) {
      sel.textContent = bufferText();
      sel.scrollTop = sel.scrollHeight; // open where the terminal is: at the newest output
    } else {
      const s = window.getSelection();
      if (s) s.removeAllRanges();
      sel.textContent = ''; // don't hold a second copy of the buffer while it's hidden
    }
  };
  // What the user actually highlighted, else everything — so Copy with nothing
  // selected still does the obviously-useful thing.
  window.__copy = () => {
    const native = window.getSelection ? String(window.getSelection()) : '';
    post({ t: 'copy', text: native.trim() ? native : bufferText() });
  };

  // --- Scrolling -------------------------------------------------------------
  // Move the viewport's scrollTop, not term.scrollLines(). scrollLines() snaps the
  // drag to whole rows and re-renders synchronously inside the touch handler, which
  // is what made this stutter; a scrollTop write is pixel-accurate and lets xterm
  // render once per frame off its own scroll event (the same path the desktop
  // scrollbar uses). Touches are coalesced to one write per frame, and a lifted
  // finger keeps coasting, so it feels like a native list rather than a ratchet.
  const viewport = host.querySelector('.xterm-viewport');
  const SLOP = 4;      // px of travel before a touch is a scroll and not a tap
  const DECAY = 0.95;  // fling velocity retained per 16ms
  const MIN_V = 0.02;  // px/ms — below this the fling has effectively stopped

  let dragging = false, moved = false;
  let startY = 0, startTop = 0, maxTop = 0;
  let lastY = 0, lastT = 0, velocity = 0;
  let target = null, frame = 0, fling = 0;

  const clamp = (top) => (top < 0 ? 0 : top > maxTop ? maxTop : top);
  const flush = () => {
    frame = 0;
    if (target === null) return;
    viewport.scrollTop = target;
    target = null;
  };
  const scrollTo = (top) => {
    target = clamp(top);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  host.addEventListener('touchstart', (e) => {
    if (selecting) return;
    cancelAnimationFrame(fling);
    fling = 0;
    dragging = e.touches.length === 1;
    if (!dragging) return;
    moved = false;
    startY = lastY = e.touches[0].clientY;
    startTop = viewport.scrollTop;
    // Read the extent once per gesture: scrollHeight forces layout, and doing it on
    // every move was half the cost of the old handler.
    maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    lastT = e.timeStamp;
    velocity = 0;
  }, { passive: true });

  host.addEventListener('touchmove', (e) => {
    if (selecting || !dragging || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    if (!moved && Math.abs(y - startY) < SLOP) return; // still might be a tap
    moved = true;
    e.preventDefault(); // no synthesized mousedown → xterm won't start selecting mid-drag
    const dt = e.timeStamp - lastT;
    if (dt > 0) {
      velocity = velocity * 0.7 + ((lastY - y) / dt) * 0.3; // smooth the jittery samples
      lastT = e.timeStamp;
    }
    lastY = y;
    scrollTo(startTop + (startY - y));
  }, { passive: false });

  host.addEventListener('touchend', (e) => {
    if (selecting || !dragging) return;
    dragging = false;
    if (!moved) { term.focus(); return; } // a tap, so raise the keyboard as xterm would
    // A finger that stopped before lifting is a park, not a flick.
    if (e.timeStamp - lastT > 100 || Math.abs(velocity) < MIN_V) return;
    let v = velocity;
    let top = target === null ? viewport.scrollTop : target;
    let prev = e.timeStamp;
    const coast = (now) => {
      const dt = Math.min(32, now - prev); // a dropped frame shouldn't teleport the view
      prev = now;
      top += v * dt;
      v *= Math.pow(DECAY, dt / 16);
      const stopped = top !== clamp(top) || Math.abs(v) < MIN_V; // hit an edge, or died out
      scrollTo(top);
      fling = stopped ? 0 : requestAnimationFrame(coast);
    };
    fling = requestAnimationFrame(coast);
  }, { passive: true });

  host.addEventListener('touchcancel', () => { dragging = false; }, { passive: true });
  window.__toBottom = () => term.scrollToBottom();
</script></body></html>`;

// btoa that survives non-Latin1 (PTY output is UTF-8 text).
function toBase64(s: string): string {
  const bytes = unescape(encodeURIComponent(s));
  // global btoa exists in RN's JSC/Hermes via polyfill on modern Expo
  return global.btoa ? global.btoa(bytes) : Buffer.from(bytes, 'binary').toString('base64');
}

// A single injectJavaScript call carries the whole payload as one string literal;
// slice the replay so a long scrollback doesn't become one enormous eval.
const WRITE_CHUNK = 60_000;

export type XtermHandle = {
  write: (data: string) => void;
  copy: () => void;
  setSelect: (on: boolean) => void;
};

type Props = {
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  // Fires on the terminal's first resize — i.e. once xterm exists and can be
  // written to. The parent replays scrollback here.
  onReady?: () => void;
  onCopy?: (text: string) => void;
};

export default forwardRef<XtermHandle, Props>(function XtermWebView(
  { onInput, onResize, onReady, onCopy },
  ref,
) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);

  useImperativeHandle(ref, () => ({
    write(data: string) {
      for (let i = 0; i < data.length; i += WRITE_CHUNK) {
        const b64 = toBase64(data.slice(i, i + WRITE_CHUNK));
        web.current?.injectJavaScript(`window.__write("${b64}"); true;`);
      }
    },
    copy() {
      web.current?.injectJavaScript('window.__copy(); true;');
    },
    setSelect(on: boolean) {
      web.current?.injectJavaScript(`window.__setSelect(${on ? 'true' : 'false'}); true;`);
    },
  }), []);

  return (
    <WebView
      ref={web}
      source={{ html: TERMINAL_HTML, baseUrl: Platform.OS === 'android' ? 'https://localhost' : undefined }}
      originWhitelist={['*']}
      onMessage={(e) => {
        const msg = JSON.parse(e.nativeEvent.data);
        if (msg.t === 'input') onInput(msg.data);
        if (msg.t === 'copy') onCopy?.(msg.text);
        if (msg.t === 'resize') {
          onResize?.(msg.cols, msg.rows);
          if (!ready.current) { ready.current = true; onReady?.(); }
        }
      }}
      style={styles.fill}
    />
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#1e1e1e' },
});
