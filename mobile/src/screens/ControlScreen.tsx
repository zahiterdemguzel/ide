// Remote desktop control: the phone shows the whole desktop screen and drives
// its mouse and keyboard. Frames arrive as JPEG over the relay ('screen-frame',
// a watched STREAM_EVENT — it flows only while this tab is focused); touches map
// to OS-level clicks/scrolls and the key bar to real keystrokes, injected on the
// desktop through nut-js. Nothing runs on the phone; this is a remote control
// with a live picture. See src/main/remote-control.js.
//
// Two pointer modes, following the AnyDesk/TeamViewer conventions:
// - Touch (absolute): a tap clicks where you touched, a long press then release
//   right-clicks, a long press then move drags, two fingers scroll or pinch.
// - Trackpad (relative): the finger moves the cursor like a laptop trackpad; a
//   tap clicks at the cursor, a two-finger tap right-clicks, a long press then
//   move drags, two fingers scroll or pinch.
// The key bar adds what a touch keyboard hasn't got — arrows, Esc/Tab, and
// sticky Ctrl/Alt/Shift/Meta so combos like Ctrl+C work.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Image, Pressable, PanResponder, ActivityIndicator, ScrollView, StyleSheet, PixelRatio,
  Animated,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Mouse, Pointer } from 'lucide-react-native';
import { useConnection } from '../api/context';
import { color, font, radius, space } from '../theme';

type DisplayInfo = { id: string; label: string; primary: boolean };
type OpenResult = {
  id: string; platform: string; screenW: number; screenH: number; input: boolean;
  warnings: string[]; displays: DisplayInfo[]; display: string | null;
};
type Region = { x: number; y: number; w: number; h: number };
type Frame = {
  seq: number; w: number; h: number; region: Region | null;
  cursor: { cx: number; cy: number } | null; b64: string;
};

// A frame may depict only a sub-rect of the screen (region streaming while
// zoomed); these are the implied *full-screen* pixel dims all layout math runs
// on, so region and full frames share one coordinate space.
const impliedFull = (f: Frame) => ({ fw: f.w / (f.region?.w ?? 1), fh: f.h / (f.region?.h ?? 1) });

// Hard cap on the streamed width, in desktop px. Frames are JPEG-in-base64 on
// the shared relay socket, so the desktop is always captured at a downscale —
// never its native resolution — and this cap keeps a frame tens of KB.
const MAX_CAPTURE_W = 640;
const FPS = 5;

// Auto-select the stream resolution on the phone's behalf: request the frame
// area's *physical* pixels (logical size × device pixel ratio) so the picture is
// as crisp as this specific screen can show, but never above MAX_CAPTURE_W. A
// low-DPI phone asks for less, a Retina phone for more — the desktop only ever
// captures what the phone asks for (clamped its side too), so the wire size
// tracks the device automatically instead of a fixed guess.
function pickCapture(w: number, h: number): { width: number; height: number; maxFps: number } | null {
  if (!w || !h) return null;
  const width = Math.min(MAX_CAPTURE_W, Math.round(w * PixelRatio.get()));
  return { width, height: Math.round((h / w) * width), maxFps: FPS };
}
const TAP_SLOP = 6;
const PINCH_SLOP = 12; // inter-finger distance change before a 2-finger gesture becomes pinch
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const LONG_PRESS_MS = 500;
const MOVE_THROTTLE_MS = 60; // live cursor-move sends while a finger drags
const CURSOR_SIZE = 12; // on-screen px, held constant regardless of zoom
const SCROLL_FLUSH_MS = 50;
const SCROLL_GAIN = 1.4; // finger px → wheel notches; a screen drag should scroll more than 1:1

type Mod = 'ctrl' | 'alt' | 'shift' | 'meta';
const MOD_ORDER: Mod[] = ['ctrl', 'alt', 'shift', 'meta'];

type PointerMode = 'touch' | 'trackpad';

export default function ControlScreen() {
  const insets = useSafeAreaInsets();
  const { conn, state } = useConnection();
  const [info, setInfo] = useState<OpenResult | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  // Last frame whose JPEG finished decoding; kept mounted under the incoming
  // frame so the swap never shows the black backing mid-decode.
  const [shown, setShown] = useState<Frame | null>(null);
  const [view, setView] = useState({ w: 0, h: 0, x: 0, y: 0 });
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const [mode, setMode] = useState<PointerMode>('touch');
  const [typing, setTyping] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  // The PanResponder is built once, so anything its handlers read must come from
  // a ref — otherwise they close over the first render's null frame/conn and no
  // gesture ever emits an event (the key bar escapes this: its handlers are
  // recreated every render). frame + conn are the two that change after mount.
  const frameRef = useRef<Frame | null>(frame);
  frameRef.current = frame;
  const connRef = useRef(conn);
  connRef.current = conn;
  const modsRef = useRef(mods);
  modsRef.current = mods;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Trackpad mode's virtual cursor, in normalized screen coords. Seeded from
  // the desktop's reported cursor between gestures, then driven by finger
  // deltas — moves are still sent as absolute positions, so the desktop side
  // needs nothing new.
  const vPos = useRef({ x: 0.5, y: 0.5 });
  // The trackpad cursor the user *sees*: a local overlay driven straight by the
  // gesture through an Animated value (setValue, no re-render), so it tracks
  // the finger instantly instead of waiting for the ~5fps frame round-trip.
  // The desktop's real cursor catches up underneath and is hidden in trackpad
  // mode to avoid showing a laggy twin.
  const localCursor = useRef(new Animated.ValueXY({ x: -100, y: -100 })).current;
  // Place the local cursor overlay at vPos, in full-screen layout coords (the
  // overlay lives inside the zoomed wrapper, so the zoom transform applies).
  const syncLocalCursor = useCallback(() => {
    const f = frameRef.current; const { w, h } = viewRef.current;
    if (!f || !w || !h) return;
    const { fw, fh } = impliedFull(f);
    const s = Math.min(w / fw, h / fh);
    const dw = fw * s; const dh = fh * s;
    localCursor.setValue({
      x: (w - dw) / 2 + vPos.current.x * dw - CURSOR_SIZE / 2,
      y: (h - dh) / 2 + vPos.current.y * dh - CURSOR_SIZE / 2,
    });
  }, [localCursor]);
  const infoRef = useRef<OpenResult | null>(null);
  infoRef.current = info;
  const displayRef = useRef<string | null>(null); // which desktop display to capture

  // Client-side view zoom/pan of the streamed frame. Applied as a transform on a
  // wrapper View around the Image+Cursor; RN scales about the view's center, so
  // all math here uses center-origin: screen = center + scale*(p - center) + t.
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const zoomRef = useRef(zoom);

  // Region streaming: tell the desktop which part of the screen is actually
  // visible so it streams only that rect, at this viewport's pixel budget —
  // zooming in raises effective density (up to the display's native px) instead
  // of magnifying a fixed-resolution frame. Debounced so a pinch doesn't spam.
  const regionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRegion = useCallback(() => {
    regionTimer.current = null;
    const c = connRef.current;
    if (!c || c.state !== 'ready') return;
    const { w, h } = viewRef.current;
    const cap = pickCapture(w, h);
    const inf = infoRef.current;
    if (!cap || !inf?.screenW || !inf?.screenH) return;
    const z = zoomRef.current;
    if (z.scale <= 1.001) { c.send('control-region', { ...cap }); return; }
    // Viewport corners → inverse zoom → normalized screen coords (same letterbox
    // math as toNorm, using the screen's aspect).
    const s = Math.min(w / inf.screenW, h / inf.screenH);
    const dw = inf.screenW * s; const dh = inf.screenH * s;
    const ox = (w - dw) / 2; const oy = (h - dh) / 2;
    const inv = (lx: number, ly: number) => ({
      x: (w / 2 + (lx - z.tx - w / 2) / z.scale - ox) / dw,
      y: (h / 2 + (ly - z.ty - h / 2) / z.scale - oy) / dh,
    });
    const a = inv(0, 0); const b = inv(w, h);
    const x = Math.max(0, a.x); const y = Math.max(0, a.y);
    c.send('control-region', {
      x, y, w: Math.min(1, b.x) - x, h: Math.min(1, b.y) - y, ...cap,
    });
  }, []);
  const queueRegion = useCallback(() => {
    if (regionTimer.current) clearTimeout(regionTimer.current);
    regionTimer.current = setTimeout(sendRegion, 200);
  }, [sendRegion]);

  const applyZoom = useCallback((scale: number, tx: number, ty: number) => {
    const { w, h } = viewRef.current;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    let z;
    if (s <= 1.001) {
      z = { scale: 1, tx: 0, ty: 0 };
    } else {
      // Keep the scaled content covering the viewport: the wrapper (w×h) scaled
      // s about its center overflows by (s-1)*w/2 per side, which bounds tx/ty.
      const mx = ((s - 1) * w) / 2; const my = ((s - 1) * h) / 2;
      z = { scale: s, tx: Math.min(mx, Math.max(-mx, tx)), ty: Math.min(my, Math.max(-my, ty)) };
    }
    zoomRef.current = z;
    setZoom(z);
    queueRegion();
  }, [queueRegion]);
  // frameArea's absolute screen position, so multi-touch pageX/pageY can be
  // mapped into frameArea-local coords (locationX is unreliable with 2 touches).
  // Measured once at layout as a seed, then re-calibrated from each gesture's
  // grant event (pageY − locationY of the same touch) — measureInWindow's
  // window coords drift on Android (status bar / late bars above the frame
  // area), which showed up as taps landing below the finger while zoomed.
  const frameAreaEl = useRef<View>(null);
  const pageOffset = useRef({ x: 0, y: 0 });
  const lastSeq = useRef(0);
  const keyInput = useRef<TextInput>(null);

  const applyInfo = useCallback((r: OpenResult) => {
    displayRef.current = r.display;
    // Every control-open restarts the desktop's frame counter at 0, so the
    // stale-frame guard must restart too — otherwise every frame after a
    // display switch is dropped as "out of order" and the picture never
    // changes.
    lastSeq.current = 0;
    setInfo(r);
  }, []);

  const metaKey = infoRef.current?.platform === 'darwin' ? 'meta' : 'ctrl';

  const send = useCallback((events: unknown[]) => {
    if (events.length) connRef.current?.send('control-input', { events });
  }, []);

  const activeMods = useCallback(() => MOD_ORDER.filter((m) => modsRef.current.has(m)), []);

  // The size the desktop should render at, auto-picked from the current frame
  // area and this device's pixel density.
  const captureSize = useCallback(() => {
    const { w, h } = viewRef.current;
    return pickCapture(w, h);
  }, []);

  const openControl = useCallback(() => {
    const size = captureSize();
    if (!conn || conn.state !== 'ready' || !size) return;
    conn.req<OpenResult>('control-open', { ...size, display: displayRef.current }).then(applyInfo).catch(() => {});
  }, [conn, captureSize, applyInfo]);

  // Switch which desktop monitor streams; the desktop re-points capture and
  // injection at it and echoes back the new geometry.
  const chooseDisplay = useCallback((id: string) => {
    const size = captureSize();
    if (!conn || conn.state !== 'ready' || !size) return;
    displayRef.current = id;
    setShown(null); // don't underlay the old display's last frame
    applyZoom(1, 0, 0); // zoom (and its streamed region) is per-display
    conn.req<OpenResult>('control-open', { ...size, display: id }).then(applyInfo).catch(() => {});
  }, [conn, captureSize, applyInfo, applyZoom]);

  // Focused + connected: start the desktop capture and watch its frames.
  // Blurred: stop watching and tell the desktop to stop capturing.
  useFocusEffect(useCallback(() => {
    if (!conn || state !== 'ready') return undefined;
    lastSeq.current = 0;
    openControl();
    const unwatch = conn.watch('screen-frame', 'main');
    const offFrame = conn.on('screen-frame', (f: Frame) => {
      if (f.seq <= lastSeq.current) return; // out-of-order frame is stale
      lastSeq.current = f.seq;
      // Between gestures, keep the trackpad's virtual cursor pinned to where
      // the desktop says the cursor really is — mid-gesture the lagging frame
      // would yank it backwards, so the gesture owns it then.
      if (f.cursor && !gesture.current.active) {
        vPos.current = { x: f.cursor.cx, y: f.cursor.cy };
        syncLocalCursor();
      }
      setFrame(f);
    });
    return () => {
      if (regionTimer.current) { clearTimeout(regionTimer.current); regionTimer.current = null; }
      offFrame();
      unwatch();
      conn.send('control-close');
      setFrame(null);
      setShown(null);
    };
  }, [conn, state, openControl]));

  // The image is `contain`ed in the frame area, so it may be letterboxed on one
  // axis. Map a touch in view px to 0..1 of the *image*, dropping touches that
  // land on the bars.
  const toNorm = useCallback((locX: number, locY: number): { x: number; y: number } | null => {
    const f = frameRef.current; const { w, h } = viewRef.current;
    if (!f || !w || !h) return null;
    // Invert the view zoom/pan first: the touch lands in frameArea coords, the
    // image lives in the (center-scaled, translated) wrapper's coords.
    const z = zoomRef.current;
    if (z.scale !== 1 || z.tx || z.ty) {
      locX = w / 2 + (locX - z.tx - w / 2) / z.scale;
      locY = h / 2 + (locY - z.ty - h / 2) / z.scale;
    }
    const { fw, fh } = impliedFull(f);
    const scale = Math.min(w / fw, h / fh);
    const dw = fw * scale; const dh = fh * scale;
    const ox = (w - dw) / 2; const oy = (h - dh) / 2;
    const x = (locX - ox) / dw; const y = (locY - oy) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, []);

  // Finger delta in view px → normalized screen delta, honouring the current
  // letterbox scale and view zoom so 1 finger-px always moves the cursor 1
  // displayed-px, whatever the zoom level.
  const normDelta = useCallback((dx: number, dy: number): { x: number; y: number } => {
    const f = frameRef.current; const { w, h } = viewRef.current;
    if (!f || !w || !h) return { x: 0, y: 0 };
    const { fw, fh } = impliedFull(f);
    const s = Math.min(w / fw, h / fh) * zoomRef.current.scale;
    return { x: dx / (fw * s), y: dy / (fh * s) };
  }, []);

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  // Scroll accumulation, flushed on a cadence so a fling is a few batched wheels.
  const scrollAcc = useRef({ dx: 0, dy: 0 });
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushScroll = useCallback(() => {
    scrollTimer.current = null;
    const { dx, dy } = scrollAcc.current;
    scrollAcc.current = { dx: 0, dy: 0 };
    if (dx || dy) send([{ k: 'scroll', dx, dy }]);
  }, [send]);

  const gesture = useRef({
    last: { x: 0, y: 0 }, moved: false, twoFinger: false, dragging: false, panning: false,
    active: false, longPressed: false, pressNorm: null as { x: number; y: number } | null,
    // Two-finger classification: 'none' until the fingers either spread/close
    // (pinch) or travel together (scroll); the first verdict sticks for the
    // whole gesture.
    twoMode: 'none' as 'none' | 'pinch' | 'scroll',
    startDist: 0, lastDist: 0, lastMid: { x: 0, y: 0 }, startMid: { x: 0, y: 0 },
    lastMoveSent: 0, longTimer: null as ReturnType<typeof setTimeout> | null,
  });

  const touchGeom = (touches: readonly { pageX: number; pageY: number }[]) => {
    const [a, b] = touches;
    return {
      dist: Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY),
      mid: {
        x: (a.pageX + b.pageX) / 2 - pageOffset.current.x,
        y: (a.pageY + b.pageY) / 2 - pageOffset.current.y,
      },
    };
  };

  // Touch position in frameArea coords. Never locationX/Y: RN reports those
  // relative to the child actually touched — the Image is absolutely positioned
  // inside a scaled wrapper, so they'd be offset by its rect and zoom. pageX/Y
  // is the finger's window position regardless of children or transforms.
  const localPoint = (e: { pageX: number; pageY: number }) => ({
    x: e.pageX - pageOffset.current.x,
    y: e.pageY - pageOffset.current.y,
  });

  const clearLong = () => {
    if (gesture.current.longTimer) { clearTimeout(gesture.current.longTimer); gesture.current.longTimer = null; }
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (evt) => {
      const g = gesture.current;
      // Self-calibrate the window→frameArea offset from this very touch: it
      // carries both window (pageX/Y) and frameArea-local (locationX/Y) coords,
      // so their difference is the exact current offset. The zoomWrap children
      // are pointerEvents="none", which keeps frameArea the touch target —
      // otherwise locationX/Y would be relative to the scaled Image instead.
      const ne = evt.nativeEvent;
      if (Number.isFinite(ne.locationX) && Number.isFinite(ne.locationY)) {
        pageOffset.current = { x: ne.pageX - ne.locationX, y: ne.pageY - ne.locationY };
      }
      g.moved = false;
      g.active = true;
      g.twoFinger = evt.nativeEvent.touches.length >= 2;
      g.dragging = false;
      g.panning = false;
      g.longPressed = false;
      g.pressNorm = null;
      g.twoMode = 'none';
      g.lastDist = 0;
      g.last = localPoint(evt.nativeEvent);
      clearLong();
      if (g.twoFinger) {
        const { dist, mid } = touchGeom(evt.nativeEvent.touches);
        g.startDist = dist; g.lastDist = dist; g.lastMid = mid; g.startMid = mid;
      } else if (modeRef.current === 'trackpad') {
        // Trackpad: the press point doesn't matter, only deltas. Arm the
        // long-press so hold-then-move becomes a drag from the cursor.
        g.longTimer = setTimeout(() => {
          g.longTimer = null;
          if (!g.moved) g.longPressed = true;
        }, LONG_PRESS_MS);
      } else {
        const n = toNorm(g.last.x, g.last.y);
        if (!n && zoomRef.current.scale > 1) {
          // Touch on the letterbox/border while zoomed: drag pans the view.
          g.panning = true;
        } else if (n) {
          g.pressNorm = n;
          // AnyDesk-style long press: hold then release right-clicks, hold
          // then move drags from the press point.
          g.longTimer = setTimeout(() => {
            g.longTimer = null;
            if (!g.moved) g.longPressed = true;
          }, LONG_PRESS_MS);
        }
      }
    },
    onPanResponderMove: (evt) => {
      const g = gesture.current;
      const touches = evt.nativeEvent.touches.length;
      const { x, y } = localPoint(evt.nativeEvent);
      const dx = x - g.last.x; const dy = y - g.last.y;
      if (Math.abs(x - g.last.x) > TAP_SLOP || Math.abs(y - g.last.y) > TAP_SLOP) { g.moved = true; clearLong(); }

      if (touches >= 2 || g.twoFinger) {
        g.twoFinger = true;
        clearLong();
        if (touches >= 2) {
          const { dist, mid } = touchGeom(evt.nativeEvent.touches);
          if (!g.lastDist) { // second finger landed after grant
            g.startDist = dist; g.startMid = mid; g.lastMid = mid;
          } else if (g.twoMode === 'none') {
            if (Math.abs(dist - g.startDist) > PINCH_SLOP) g.twoMode = 'pinch';
            else if (Math.hypot(mid.x - g.startMid.x, mid.y - g.startMid.y) > PINCH_SLOP) g.twoMode = 'scroll';
          }
          if (g.twoMode === 'pinch' && g.lastDist) {
            // Focal-point zoom: keep the content point under the (moving) focal
            // fixed. With center-origin transform screen = c + s*(p-c) + t, the
            // point under the previous focal F0 is p-c = (F0 - t0 - c)/s0, and
            // pinning it under the new focal F1 gives t1 = F1 - c - s1*(p-c).
            const z = zoomRef.current;
            const { w, h } = viewRef.current;
            const s1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z.scale * (dist / g.lastDist)));
            const r = s1 / z.scale;
            applyZoom(
              s1,
              mid.x - w / 2 - r * (g.lastMid.x - z.tx - w / 2),
              mid.y - h / 2 - r * (g.lastMid.y - z.ty - h / 2),
            );
          }
          g.lastDist = dist; g.lastMid = mid;
        }
        if (g.twoMode === 'scroll') {
          scrollAcc.current.dx += Math.round(dx * SCROLL_GAIN);
          scrollAcc.current.dy += Math.round(dy * SCROLL_GAIN);
          if (!scrollTimer.current) scrollTimer.current = setTimeout(flushScroll, SCROLL_FLUSH_MS);
        }
        g.last = { x, y };
        return;
      }
      g.last = { x, y };
      if (g.panning) {
        const z = zoomRef.current;
        applyZoom(z.scale, z.tx + dx, z.ty + dy);
        return;
      }
      if (modeRef.current === 'trackpad') {
        // Relative: the finger nudges the virtual cursor. A completed long
        // press turns the first move into a left-button drag from the cursor.
        const d = normDelta(dx, dy);
        vPos.current = { x: clamp01(vPos.current.x + d.x), y: clamp01(vPos.current.y + d.y) };
        syncLocalCursor();
        if (g.longPressed && !g.dragging) {
          g.dragging = true;
          send([{ k: 'down', x: vPos.current.x, y: vPos.current.y, button: 'left' }]);
        }
        const now = Date.now();
        if (now - g.lastMoveSent >= MOVE_THROTTLE_MS) {
          g.lastMoveSent = now;
          send([{ k: 'move', x: vPos.current.x, y: vPos.current.y }]);
        }
        return;
      }
      // Touch: a completed long press turns the first move into a drag from the
      // press point (button down there, then the cursor tracks the finger).
      if (g.longPressed && !g.dragging && g.pressNorm) {
        g.dragging = true;
        send([{ k: 'down', x: g.pressNorm.x, y: g.pressNorm.y, button: 'left' }]);
      }
      // Move the cursor there live (throttled) so the user sees where a click
      // will land, and so a drag tracks the finger.
      const n = toNorm(x, y);
      const now = Date.now();
      if (n && now - g.lastMoveSent >= MOVE_THROTTLE_MS) {
        g.lastMoveSent = now;
        send([{ k: 'move', x: n.x, y: n.y }]);
      }
    },
    onPanResponderRelease: () => {
      const g = gesture.current;
      clearLong();
      if (scrollTimer.current) { clearTimeout(scrollTimer.current); flushScroll(); }
      const trackpad = modeRef.current === 'trackpad';
      if (g.dragging) {
        const end = trackpad ? vPos.current : toNorm(g.last.x, g.last.y);
        send(end
          ? [{ k: 'move', x: end.x, y: end.y }, { k: 'up', button: 'left' }]
          : [{ k: 'up', button: 'left' }]);
      } else if (g.twoFinger) {
        // Two-finger tap (no scroll/pinch happened) right-clicks at the cursor
        // — the trackpad convention; touch mode right-clicks via long press.
        if (trackpad && g.twoMode === 'none' && !g.moved) {
          send([{ k: 'tap', x: vPos.current.x, y: vPos.current.y, button: 'right', mods: activeMods() }]);
        }
      } else if (!g.panning && !g.moved) {
        const p = trackpad ? vPos.current : (g.longPressed ? g.pressNorm : toNorm(g.last.x, g.last.y));
        if (p) send([{ k: 'tap', x: p.x, y: p.y, button: g.longPressed ? 'right' : 'left', mods: activeMods() }]);
      }
      g.active = false; g.longPressed = false; g.pressNorm = null;
      g.twoFinger = false; g.dragging = false; g.panning = false; g.twoMode = 'none';
    },
    onPanResponderTerminate: () => {
      const g = gesture.current;
      clearLong();
      if (g.dragging) send([{ k: 'up', button: 'left' }]); // never leave the button stuck down
      g.active = false; g.longPressed = false; g.pressNorm = null;
      g.dragging = false; g.panning = false; g.twoMode = 'none';
    },
  })).current;

  const doubleClick = () => {
    const g = gesture.current;
    const n = modeRef.current === 'trackpad' ? vPos.current : toNorm(g.last.x, g.last.y);
    if (n) send([{ k: 'tap', x: n.x, y: n.y, button: 'left', double: true, mods: activeMods() }]);
  };

  const pressKey = (key: string) => {
    send([{ k: 'key', key, mods: activeMods() }]);
    // Sticky-once: a modifier chorded into a key press releases after it fires,
    // unless the user has it locked (double-tapped — tracked as always-on here by
    // staying in the set only via explicit toggle). We clear non-locked mods.
    if (modsRef.current.size) setMods(new Set());
  };

  // First tap arms a modifier for the next key (a chord like Ctrl+C). A second
  // tap on an already-armed modifier presses it on its own — a lone modifier
  // never chords into a following key, and this is the only way to fire Win
  // (open Start) or Alt by itself.
  const toggleMod = (m: Mod) => {
    if (modsRef.current.has(m)) {
      send([{ k: 'key', key: m, mods: [] }]);
      setMods((prev) => { const next = new Set(prev); next.delete(m); return next; });
    } else {
      setMods((prev) => { const next = new Set(prev); next.add(m); return next; });
    }
  };

  const onFrameLayout = (e: any) => {
    const { width, height, x, y } = e.nativeEvent.layout;
    const changed = Math.abs(width - viewRef.current.w) > 2 || Math.abs(height - viewRef.current.h) > 2;
    setView({ w: width, h: height, x, y });
    frameAreaEl.current?.measureInWindow((px, py) => { pageOffset.current = { x: px, y: py }; });
    if (changed) applyZoom(1, 0, 0); // a resized viewport invalidates the pan clamp
    syncLocalCursor(); // the letterbox rect moved with the viewport
    const cap = pickCapture(width, height);
    if (changed && conn?.state === 'ready' && cap) {
      conn.req<OpenResult>('control-open', { ...cap, display: displayRef.current }).then(applyInfo).catch(() => {});
    } else if (!frame) {
      openControl();
    }
  };

  // Free typing: the hidden input turns the soft keyboard into keystrokes. Each
  // char is forwarded and the field kept empty, so there is nothing to diff.
  const onKeyPress = (e: any) => {
    const key = e.nativeEvent.key as string;
    if (key === 'Backspace') pressKey('backspace');
    else if (key === 'Enter') pressKey('enter');
    else if (key === ' ') pressKey('space');
    else if (key.length === 1) {
      send([{ k: 'text', text: key, mods: activeMods() }]);
      if (modsRef.current.size) setMods(new Set());
    }
  };

  const displayList = info?.displays ?? [];

  // Where a frame's pixels sit in full-screen layout space: a region frame is
  // drawn at its rect, so the (unchanged) zoom transform magnifies it into
  // exactly the visible viewport — at the higher resolution it now carries.
  const rectFor = (f: Frame) => {
    if (!view.w || !view.h) return null;
    const { fw, fh } = impliedFull(f);
    const s = Math.min(view.w / fw, view.h / fh);
    const dw = fw * s; const dh = fh * s;
    const ox = (view.w - dw) / 2; const oy = (view.h - dh) / 2;
    const r = f.region ?? { x: 0, y: 0, w: 1, h: 1 };
    return { left: ox + r.x * dw, top: oy + r.y * dh, width: r.w * dw, height: r.h * dh };
  };
  const frameRect = frame ? rectFor(frame) : null;
  const shownRect = shown && shown !== frame ? rectFor(shown) : null;

  return (
    <View style={[styles.fill, { paddingTop: insets.top }]}>
      {displayList.length > 1 ? (
        <View style={styles.displayBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.displayRow}>
            {displayList.map((d) => {
              const on = d.id === (info?.display ?? displayRef.current);
              return (
                <Pressable
                  key={d.id}
                  style={[styles.displayChip, on && styles.displayChipOn]}
                  onPress={() => chooseDisplay(d.id)}
                >
                  <Ionicons name="desktop-outline" size={13} color={on ? '#fff' : color.muted} />
                  <Text style={[styles.displayChipText, on && styles.displayChipTextOn]}>{d.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {info?.warnings?.length ? (
        <View style={styles.warn}>
          {info.warnings.map((w) => <Text key={w} style={styles.warnText}>{w}</Text>)}
        </View>
      ) : null}

      <View ref={frameAreaEl} style={styles.frameArea} onLayout={onFrameLayout} {...pan.panHandlers}>
        {frame ? (
          <View
            pointerEvents="none"
            style={[
              styles.zoomWrap,
              { transform: [{ translateX: zoom.tx }, { translateY: zoom.ty }, { scale: zoom.scale }] },
            ]}
          >
            {shown && shown !== frame ? (
              // Last fully-decoded frame, kept underneath while the new source
              // decodes — without it the Image goes blank mid-decode and the
              // black frame area flashes through on every screen change.
              <Image
                source={{ uri: `data:image/jpeg;base64,${shown.b64}` }}
                style={shownRect ? [styles.frameRegion, shownRect] : styles.frame}
                resizeMode={shownRect ? 'stretch' : 'contain'}
                fadeDuration={0}
              />
            ) : null}
            <Image
              source={{ uri: `data:image/jpeg;base64,${frame.b64}` }}
              style={frameRect ? [styles.frameRegion, frameRect] : styles.frame}
              resizeMode={frameRect ? 'stretch' : 'contain'}
              fadeDuration={0}
              onLoad={() => setShown(frame)}
            />
            {mode === 'trackpad' ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.cursor,
                  styles.localCursor,
                  {
                    transform: [
                      { translateX: localCursor.x }, { translateY: localCursor.y }, { scale: 1 / (zoom.scale || 1) },
                    ],
                  },
                ]}
              />
            ) : frame.cursor ? (
              <Cursor cx={frame.cursor.cx} cy={frame.cursor.cy} frame={frame} view={view} zoom={zoom.scale} />
            ) : null}
          </View>
        ) : (
          <View pointerEvents="none" style={styles.empty}>
            {state === 'ready' ? <ActivityIndicator color={color.muted} /> : null}
            <Text style={styles.emptyText}>
              {state === 'ready' ? 'Starting desktop capture…' : 'Waiting for the desktop connection…'}
            </Text>
          </View>
        )}
      </View>

      {/* Key bar: the keys a touch keyboard hasn't got, plus sticky modifiers. */}
      <View style={styles.keyBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keyRow}>
          <ModKey label="Ctrl" on={mods.has('ctrl')} onPress={() => toggleMod('ctrl')} />
          <ModKey label="Alt" on={mods.has('alt')} onPress={() => toggleMod('alt')} />
          <ModKey label="Shift" on={mods.has('shift')} onPress={() => toggleMod('shift')} />
          <ModKey label={metaKey === 'meta' ? 'Cmd' : 'Win'} on={mods.has('meta')} onPress={() => toggleMod('meta')} />
          <Sep />
          <Key icon="arrow-up" onPress={() => pressKey('up')} />
          <Key icon="arrow-down" onPress={() => pressKey('down')} />
          <Key icon="arrow-back" onPress={() => pressKey('left')} />
          <Key icon="arrow-forward" onPress={() => pressKey('right')} />
          <Sep />
          <Key label="Esc" onPress={() => pressKey('escape')} />
          <Key label="Tab" onPress={() => pressKey('tab')} />
          <Key label="↵" onPress={() => pressKey('enter')} />
          <Key label="⌫" onPress={() => pressKey('backspace')} />
          <Key label="Space" wide onPress={() => pressKey('space')} />
        </ScrollView>
      </View>

      {/* Action bar: pointer-mode switch, double-click, and the typing toggle. */}
      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.action, styles.modeBtn, pressed && styles.keyPressed]}
          onPress={() => { syncLocalCursor(); setMode((m) => (m === 'touch' ? 'trackpad' : 'touch')); }}
        >
          {mode === 'touch'
            ? <Pointer size={18} color={color.text} />
            : <Mouse size={18} color={color.text} />}
        </Pressable>
        <Action icon="repeat" label="Double-click" onPress={doubleClick} />
        <Action
          icon="keypad"
          label={typing ? 'Typing' : 'Type'}
          active={typing}
          onPress={() => { if (typing) keyInput.current?.blur(); else keyInput.current?.focus(); }}
        />
      </View>

      {/* Off-screen, not display:none — a hidden input can't hold the keyboard. */}
      <TextInput
        ref={keyInput}
        style={styles.keyCatcher}
        value=""
        onKeyPress={onKeyPress}
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
    </View>
  );
}

// The desktop's own cursor, painted over the frame at its reported position —
// laid out against the letterboxed image, not the whole frame area.
function Cursor(
  { cx, cy, frame, view, zoom }:
  { cx: number; cy: number; frame: Frame; view: { w: number; h: number }; zoom: number },
) {
  if (!view.w || !view.h) return null;
  const { fw, fh } = impliedFull(frame);
  const scale = Math.min(view.w / fw, view.h / fh);
  const dw = fw * scale; const dh = fh * scale;
  const ox = (view.w - dw) / 2; const oy = (view.h - dh) / 2;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.cursor,
        { left: ox + cx * dw - CURSOR_SIZE / 2, top: oy + cy * dh - CURSOR_SIZE / 2 },
        // The wrapper is zoomed, so counter-scale to keep a constant on-screen
        // size. RN scales about the view's centre, which is the cursor point.
        { transform: [{ scale: 1 / (zoom || 1) }] },
      ]}
    />
  );
}

function Key(
  { icon, label, wide, onPress }:
  { icon?: keyof typeof Ionicons.glyphMap; label?: string; wide?: boolean; onPress: () => void },
) {
  return (
    <Pressable
      style={({ pressed }) => [styles.key, wide && styles.keyWide, pressed && styles.keyPressed]}
      onPress={onPress}
    >
      {icon ? <Ionicons name={icon} size={18} color={color.text} />
        : <Text style={styles.keyLabel}>{label}</Text>}
    </Pressable>
  );
}

function ModKey({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.key, styles.modKey, on && styles.modKeyOn]} onPress={onPress}>
      <Text style={[styles.keyLabel, on && styles.modKeyOnText]}>{label}</Text>
    </Pressable>
  );
}

const Sep = () => <View style={styles.sep} />;

function Action(
  { icon, label, active, onPress }:
  { icon: keyof typeof Ionicons.glyphMap; label: string; active?: boolean; onPress: () => void },
) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, active && styles.actionOn, pressed && styles.keyPressed]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={16} color={active ? color.accent : color.text} />
      <Text style={[styles.actionLabel, active && { color: color.accent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: color.bg },
  displayBar: {
    paddingVertical: 6, backgroundColor: color.surface, borderBottomWidth: 1, borderBottomColor: color.border,
  },
  displayRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  displayChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10,
    borderRadius: radius.sm, backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  displayChipOn: { backgroundColor: color.accentDim, borderColor: color.accent },
  displayChipText: { color: color.muted, fontSize: font.size.sm, fontWeight: '600' },
  displayChipTextOn: { color: '#fff' },
  warn: {
    marginHorizontal: 12, marginTop: 8, marginBottom: 8, padding: 10, gap: 6,
    backgroundColor: color.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.yellow,
  },
  warnText: { color: color.yellow, fontSize: font.size.sm },
  frameArea: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  zoomWrap: { flex: 1 },
  frame: { flex: 1 },
  frameRegion: { position: 'absolute' },
  cursor: {
    position: 'absolute', width: CURSOR_SIZE, height: CURSOR_SIZE, borderRadius: CURSOR_SIZE / 2,
    backgroundColor: color.accent, borderWidth: 1.5, borderColor: '#fff', opacity: 0.85,
  },
  localCursor: { left: 0, top: 0 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { color: color.muted, fontSize: font.size.sm },
  keyBar: { paddingVertical: 8, backgroundColor: color.surface, borderTopWidth: 1, borderTopColor: color.border },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 },
  key: {
    minWidth: 38, height: 38, paddingHorizontal: 10, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  keyWide: { minWidth: 80 },
  keyPressed: { backgroundColor: color.raisedHi },
  keyLabel: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  modKey: { minWidth: 44 },
  modKeyOn: { backgroundColor: color.accentDim, borderColor: color.accent },
  modKeyOnText: { color: '#fff' },
  sep: { width: 1, height: 24, backgroundColor: color.border, marginHorizontal: 2 },
  actions: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: space.md,
    backgroundColor: color.surface,
  },
  action: {
    flex: 1, flexDirection: 'row', gap: 6, height: 38, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.raised, borderWidth: 1, borderColor: color.border,
  },
  actionOn: { borderColor: color.accent },
  modeBtn: { flex: 0, minWidth: 46, paddingHorizontal: 0 },
  actionLabel: { color: color.text, fontSize: font.size.sm, fontWeight: '600' },
  keyCatcher: { position: 'absolute', left: -1000, top: -1000, width: 50, height: 30 },
});
