// Remote browser: the page renders in an offscreen window inside the desktop
// app and arrives here as JPEG frames over the relay socket; touches, scrolls
// and typing go back as normalized input events the desktop injects. Nothing
// runs on the phone — this screen is a remote control with a picture.
//
// The frame stream is a watched STREAM_EVENT ('browser-frame' id 'main'), so
// it flows only while this tab is focused; blurring the tab closes the desktop
// window and the stream with it.
//
// Two invariants keep interaction correct:
// - The capture size the desktop renders at is derived from the *keyboard-free*
//   layout only, and while the keyboard is up the frame area is pinned to that
//   keyboard-free height instead of shrinking with the window (Android resizes
//   the window on keyboard open) — so the keyboard overlays the bottom of the
//   page rather than squeezing or reflowing it. Resizing the desktop viewport to
//   the transient keyboard shape would break the aspect on every open/close.
// - Touch coordinates are normalized against the *displayed image rect* (the
//   `contain` fit of the frame inside the area), not the raw view — so taps
//   stay accurate even when the view's aspect no longer matches the frame's.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Image, Pressable, PanResponder, ActivityIndicator, Keyboard, StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { useConnection } from '../api/context';
import ScreenHeader from '../components/ScreenHeader';
import { storageKey } from '../api/storage';
import { color, radius, font } from '../theme';

type BrowserState = {
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
};
type Frame = { seq: number; w: number; h: number; b64: string };
type Mode = 'mobile' | 'desktop';

// Capture widths, in CSS px on the desktop side. Frames are JPEG-in-base64 on a
// shared relay socket — capping the viewport is what keeps a frame tens of
// kilobytes instead of hundreds. Mobile mode renders at (near) phone width with
// a phone UA, so sites serve their mobile layout; desktop mode renders a
// desktop-width viewport and letterboxes it into the same screen.
const MOBILE_CAPTURE_W = 480;
const DESKTOP_CAPTURE_W = 1024;
// A drag under this many px is a tap.
const TAP_SLOP = 8;
// Scroll deltas accumulate and flush on this cadence, so a fling is a few
// batched events instead of one per touch move.
const SCROLL_FLUSH_MS = 50;

// Addresses the user has navigated to, newest first — what an emptied URL field
// offers as one-tap suggestions. Typed/tapped entries only, never every page a
// click walks through; deduped, capped, persisted beside the other app state.
const KEY_RECENTS = storageKey('browserRecents');
const RECENTS_MAX = 8;
// The sticky mobile/desktop viewport choice.
const KEY_MODE = storageKey('browserMode');

async function loadRecents(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY_RECENTS);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(list: string[], url: string): string[] {
  return [url, ...list.filter((u) => u !== url)].slice(0, RECENTS_MAX);
}

// Fire-and-forget: losing a history entry never matters more than navigating.
function saveRecents(list: string[]) {
  SecureStore.setItemAsync(KEY_RECENTS, JSON.stringify(list)).catch(() => {});
}

export default function BrowserScreen() {
  const { conn, state } = useConnection();
  const [urlText, setUrlText] = useState('');
  const [page, setPage] = useState<BrowserState | null>(null);
  // Double buffer: `frame` is the newest arrival (decoding on top), `shown` is
  // the last frame that finished decoding (painted underneath). Swapping a lone
  // Image's data-URI source blanks it for the decode gap — a visible black
  // flash on every scroll frame. Promoting on onLoad means the old frame stays
  // up until the new one has pixels.
  const [frame, setFrame] = useState<Frame | null>(null);
  const [shown, setShown] = useState<Frame | null>(null);
  const [mode, setMode] = useState<Mode>('mobile');
  const [keys, setKeys] = useState(false); // remote-typing mode (hidden input focused)
  const [recents, setRecents] = useState<string[]>([]);
  const [urlFocused, setUrlFocused] = useState(false);
  // Soft keyboard up: pin the frame to its keyboard-free height so the keyboard
  // overlays the page's bottom instead of resizing the frame area with it.
  const [kbShown, setKbShown] = useState(false);

  const lastUrl = useRef('https://google.com');
  const lastSeq = useRef(0);
  // Live layout of the frame area (shrinks under the keyboard) vs the last
  // keyboard-free layout (what the capture size is derived from).
  const viewRef = useRef({ w: 0, h: 0 });
  const stableView = useRef({ w: 0, h: 0 });
  const kbVisible = useRef(false);
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const connRef = useRef(conn);
  connRef.current = conn;
  // The capture size last sent to the desktop — a layout landing on the same
  // size (keyboard closing, tab refocus) must not re-send a resize.
  const lastCapture = useRef<{ width: number; height: number } | null>(null);
  const opened = useRef(false);
  const keyInput = useRef<TextInput>(null);
  // Whether the URL field is being edited — while it is, incoming browser-state
  // must not stomp what the user is typing.
  const editingUrl = useRef(false);
  // Blur must not hide the suggestions before a tap on one lands — the row's
  // press fires after the field's blur. A short grace period covers the gap.
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The stored history is also the start page: the newest entry is where the
  // browser reopens next launch, and only with no history at all does it fall
  // back to the google.com default `lastUrl` starts with. The first browser-open
  // waits on this load (`recentsLoaded`), or it would race in with the default.
  const [recentsLoaded, setRecentsLoaded] = useState(false);
  useEffect(() => {
    loadRecents().then((list) => {
      setRecents(list);
      if (list[0]) lastUrl.current = list[0];
      setRecentsLoaded(true);
    });
    SecureStore.getItemAsync(KEY_MODE).then((m) => {
      if (m === 'desktop' || m === 'mobile') { setMode(m); modeRef.current = m; }
    }).catch(() => {});
  }, []);

  const recordRecent = useCallback((url: string) => {
    setRecents((prev) => {
      const next = pushRecent(prev, url);
      saveRecents(next);
      return next;
    });
  }, []);

  // The size the desktop should render at, derived from the *keyboard-free*
  // layout: same aspect ratio as the frame area, scaled to the mode's capture
  // width, so `contain` fills it exactly while the keyboard is closed.
  const captureSize = useCallback(() => {
    const { w, h } = stableView.current;
    if (!w || !h) return null;
    const capW = modeRef.current === 'desktop' ? DESKTOP_CAPTURE_W : Math.min(w, MOBILE_CAPTURE_W);
    return { width: Math.round(capW), height: Math.round(h * (capW / w)) };
  }, []);

  const openBrowser = useCallback(() => {
    const size = captureSize();
    const c = connRef.current;
    if (!c || c.state !== 'ready' || !size) return;
    lastCapture.current = size;
    opened.current = true;
    c.req<BrowserState & { id: string }>('browser-open', {
      url: lastUrl.current, mode: modeRef.current, maxFps: 15, ...size,
    })
      .then((res) => { if (!editingUrl.current) setUrlText(res.url); })
      .catch(() => {});
  }, [captureSize]);

  // Push the current capture size to the desktop only if it actually changed —
  // called from keyboard-free layouts and when the keyboard closes.
  const syncSize = useCallback(() => {
    const size = captureSize();
    const c = connRef.current;
    if (!size || !c || c.state !== 'ready') return;
    if (!opened.current) { openBrowser(); return; }
    const last = lastCapture.current;
    if (last && last.width === size.width && last.height === size.height) return;
    lastCapture.current = size;
    c.send('browser-resize', size);
  }, [captureSize, openBrowser]);

  // Track the keyboard so layouts it causes are recognized as transient. The
  // hide event also re-syncs, in case the restoring layout fired while the
  // flag was still up — and blurs the key catcher: dismissing the keyboard
  // with the system back gesture doesn't blur a focused RN input, which left
  // remote-typing mode (the highlighted keyboard button) stuck on.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => { kbVisible.current = true; setKbShown(true); });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      kbVisible.current = false;
      setKbShown(false);
      keyInput.current?.blur();
      syncSize();
    });
    return () => { show.remove(); hide.remove(); };
  }, [syncSize]);

  // Focused + connected: open the desktop window and watch its frames.
  // Blurred: stop watching and tear the desktop window down.
  useFocusEffect(useCallback(() => {
    if (!conn || state !== 'ready' || !recentsLoaded) return;
    lastSeq.current = 0;
    lastCapture.current = null;
    opened.current = false;
    openBrowser();
    const unwatch = conn.watch('browser-frame', 'main');
    const offFrame = conn.on('browser-frame', (f: Frame) => {
      if (f.seq <= lastSeq.current) return; // an out-of-order frame is stale — drop it
      lastSeq.current = f.seq;
      setFrame(f);
    });
    const offState = conn.on('browser-state', (s: BrowserState & { url: string }) => {
      setPage(s);
      if (s.url && s.url !== 'about:blank') {
        lastUrl.current = s.url;
        if (!editingUrl.current) setUrlText(s.url);
      }
    });
    return () => {
      offFrame();
      offState();
      unwatch();
      conn.send('browser-close');
      opened.current = false;
      setFrame(null);
      setShown(null);
    };
  }, [conn, state, openBrowser]));

  const navigate = (to?: string) => {
    const url = (to ?? urlText).trim();
    if (!url || !conn) return;
    lastUrl.current = url;
    setUrlText(url);
    conn.send('browser-navigate', { url });
    recordRecent(url);
    editingUrl.current = false;
    keyInput.current?.blur();
  };

  const nav = (action: 'back' | 'forward' | 'reload' | 'stop') => conn?.send('browser-nav', { action });

  // Mobile ↔ desktop viewport. The desktop window is re-opened at the new size
  // and user agent — a UA must be set before the page loads to take effect.
  const toggleMode = () => {
    const next: Mode = mode === 'mobile' ? 'desktop' : 'mobile';
    setMode(next);
    modeRef.current = next;
    SecureStore.setItemAsync(KEY_MODE, next).catch(() => {});
    lastCapture.current = null;
    openBrowser();
  };

  // Where a touch landed *on the page*, as 0..1 of the frame. The image is
  // `contain`-fit, so when the view's aspect differs from the frame's (the mode
  // just flipped) the picture is inset — map through that displayed rect, and
  // ignore touches on the letterbox unless clamping is asked for.
  const toFrameNorm = (px: number, py: number, clamp: boolean) => {
    const { w, h } = viewRef.current;
    const f = frameRef.current;
    if (!w || !h || !f || !f.w || !f.h) return null;
    const scale = Math.min(w / f.w, h / f.h);
    const dw = f.w * scale;
    const dh = f.h * scale;
    const x = (px - (w - dw) / 2) / dw;
    const y = (py - (h - dh) / 2) / dh;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  // Gestures over the frame. A press that barely moves is a tap; a drag streams
  // scroll deltas. Coordinates leave normalized 0..1 — only the desktop knows
  // the real viewport size, so a resize can never race a touch.
  const scrollAcc = useRef({ dx: 0, dy: 0, x: 0.5, y: 0.5 });
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushScroll = () => {
    scrollTimer.current = null;
    const { dx, dy, x, y } = scrollAcc.current;
    scrollAcc.current = { dx: 0, dy: 0, x, y };
    if (dx || dy) connRef.current?.send('browser-input', { events: [{ k: 'scroll', x, y, dx, dy }] });
  };

  // The previous move's gesture offset, so each move contributes only its delta.
  // The PanResponder is created once — everything it touches lives in refs.
  const lastDrag = useRef({ dx: 0, dy: 0 });
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { lastDrag.current = { dx: 0, dy: 0 }; },
    onPanResponderMove: (evt, g) => {
      const at = toFrameNorm(evt.nativeEvent.locationX, evt.nativeEvent.locationY, true);
      if (!at) return;
      const acc = scrollAcc.current;
      // Content follows the finger: a drag up (negative dy) scrolls the page down,
      // which is a negative wheel deltaY — so the drag delta passes through as-is.
      acc.dx += g.dx - lastDrag.current.dx;
      acc.dy += g.dy - lastDrag.current.dy;
      lastDrag.current = { dx: g.dx, dy: g.dy };
      acc.x = at.x;
      acc.y = at.y;
      // Leading edge + trailing edge: the first move of a burst flushes
      // immediately (the page starts following the finger a flush period
      // sooner), the rest batch onto the timer.
      if (!scrollTimer.current) {
        flushScroll();
        scrollTimer.current = setTimeout(flushScroll, SCROLL_FLUSH_MS);
      }
    },
    onPanResponderRelease: (evt, g) => {
      if (Math.abs(g.dx) >= TAP_SLOP || Math.abs(g.dy) >= TAP_SLOP) return;
      const at = toFrameNorm(evt.nativeEvent.locationX, evt.nativeEvent.locationY, false);
      if (at) connRef.current?.send('browser-input', { events: [{ k: 'tap', ...at }] });
    },
  })).current;

  const onFrameLayout = (e: any) => {
    const { width, height } = e.nativeEvent.layout;
    viewRef.current = { w: width, h: height };
    // A layout under the open keyboard is transient — the frame area is pinned
    // to its keyboard-free height (see the pinned style below), so this never
    // updates the stable size or re-syncs the capture until the keyboard closes.
    if (kbVisible.current) return;
    stableView.current = { w: width, h: height };
    syncSize();
  };

  // The hidden input turns the soft keyboard into remote keystrokes: each key
  // press is forwarded and the field stays empty, so there is nothing to diff.
  const onKeyPress = (e: any) => {
    const key = e.nativeEvent.key as string;
    if (!conn) return;
    if (key === 'Backspace' || key === 'Enter') {
      conn.send('browser-input', { events: [{ k: 'key', key }] });
    } else if (key.length === 1) {
      conn.send('browser-input', { events: [{ k: 'text', text: key }] });
    }
  };

  return (
    <View style={styles.fill}>
      <ScreenHeader />

      <View style={styles.toolbar}>
        <NavBtn icon="chevron-back" disabled={!page?.canGoBack} onPress={() => nav('back')} />
        <NavBtn icon="chevron-forward" disabled={!page?.canGoForward} onPress={() => nav('forward')} />
        <TextInput
          style={styles.urlInput}
          value={urlText}
          onChangeText={setUrlText}
          onFocus={() => {
            editingUrl.current = true;
            if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
            setUrlFocused(true);
          }}
          onBlur={() => {
            editingUrl.current = false;
            blurTimer.current = setTimeout(() => { blurTimer.current = null; setUrlFocused(false); }, 150);
          }}
          onSubmitEditing={() => navigate()}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          placeholder="Enter address"
          placeholderTextColor={color.faint}
        />
        <NavBtn icon={page?.loading ? 'close' : 'refresh'} onPress={() => nav(page?.loading ? 'stop' : 'reload')} />
        <NavBtn
          icon={mode === 'mobile' ? 'phone-portrait-outline' : 'desktop-outline'}
          onPress={toggleMode}
        />
        <NavBtn
          icon="text-outline"
          active={keys}
          onPress={() => {
            if (keys) keyInput.current?.blur(); else keyInput.current?.focus();
          }}
        />
      </View>

      {/* An emptied address field offers the latest typed addresses, one tap each.
          Floats over the frame (same card language as the app's menus) so the
          viewport never reflows under it. */}
      {urlFocused && !urlText.trim() && recents.length > 0 && (
        <View style={styles.recentsAnchor}>
          <View style={styles.recents}>
            {recents.map((u) => (
              <Pressable
                key={u}
                style={({ pressed }) => [styles.recentRow, pressed && styles.recentRowPressed]}
                onPress={() => navigate(u)}
              >
                <Ionicons name="time-outline" size={15} color={color.muted} />
                <Text style={styles.recentText} numberOfLines={1}>{u}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View
        style={[styles.frameArea, kbShown && stableView.current.h ? { flex: 0, height: stableView.current.h } : null]}
        onLayout={onFrameLayout}
        {...pan.panHandlers}
      >
        {(shown || frame) ? (
          <>
            {/* The last decoded frame stays painted underneath… */}
            {shown && (
              <Image
                source={{ uri: `data:image/jpeg;base64,${shown.b64}` }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                fadeDuration={0}
              />
            )}
            {/* …while the newest one decodes invisibly on top and is promoted
                only once it has pixels — no black flash between frames. */}
            {frame && frame !== shown && (
              <Image
                source={{ uri: `data:image/jpeg;base64,${frame.b64}` }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
                fadeDuration={0}
                onLoad={() => setShown(frame)}
              />
            )}
          </>
        ) : (
          <View style={styles.empty}>
            {state === 'ready' ? <ActivityIndicator color={color.muted} /> : null}
            <Text style={styles.emptyText}>
              {state === 'ready' ? 'Starting desktop browser…' : 'Waiting for the desktop connection…'}
            </Text>
          </View>
        )}
        {page?.loading && (shown || frame) ? <ActivityIndicator style={styles.spinner} color={color.accent} /> : null}
      </View>

      {/* Off-screen, not display:none — a hidden input can't hold the keyboard. */}
      <TextInput
        ref={keyInput}
        style={styles.keyCatcher}
        value=""
        onKeyPress={onKeyPress}
        onFocus={() => setKeys(true)}
        onBlur={() => setKeys(false)}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
    </View>
  );
}

function NavBtn(
  { icon, disabled, active, onPress }:
  { icon: keyof typeof Ionicons.glyphMap; disabled?: boolean; active?: boolean; onPress: () => void },
) {
  return (
    <Pressable
      style={({ pressed }) => [styles.navBtn, active && styles.navBtnActive, pressed && styles.navBtnPressed]}
      disabled={disabled}
      onPress={onPress}
    >
      <Ionicons name={icon} size={18} color={disabled ? color.faint : active ? color.accent : color.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingBottom: 10,
  },
  navBtn: {
    width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
  },
  navBtnActive: { borderColor: color.accent },
  navBtnPressed: { backgroundColor: color.raisedHi },
  urlInput: {
    flex: 1, height: 36, paddingHorizontal: 10, borderRadius: 9,
    backgroundColor: color.bg, borderWidth: 1, borderColor: color.border,
    color: color.text, fontSize: font.size.sm, fontFamily: font.mono,
    // A fixed-height TextInput clips and scrolls vertically unless the platform's
    // own padding and font padding are zeroed out and the text is centered.
    paddingVertical: 0, textAlignVertical: 'center', includeFontPadding: false,
  },
  // A zero-height anchor between the toolbar and the frame: the card hangs from
  // it absolutely, so it floats over the viewport without reflowing it and stays
  // pinned under the toolbar whatever the header measures.
  recentsAnchor: { zIndex: 10, height: 0 },
  recents: {
    position: 'absolute',
    top: 0, left: 12, right: 12, elevation: 10,
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.border,
    borderRadius: radius.md, paddingVertical: 4, overflow: 'hidden',
  },
  recentRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  recentRowPressed: { backgroundColor: color.raisedHi },
  recentText: { flex: 1, color: color.text, fontSize: font.size.sm, fontFamily: font.mono },
  frameArea: { flex: 1, backgroundColor: '#000' },
  frame: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { color: color.muted, fontSize: font.size.sm },
  spinner: { position: 'absolute', top: 10, right: 10 },
  keyCatcher: { position: 'absolute', left: -1000, top: -1000, width: 50, height: 30 },
});
