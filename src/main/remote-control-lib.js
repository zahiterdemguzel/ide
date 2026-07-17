// Pure logic behind remote desktop control (src/main/remote-control.js):
// capture-size/fps/quality clamping, normalized phone input → abstract OS input
// ops, and the key-name → nut-js Key mapping. No Electron, no nut-js — the glue
// resolves op names against whatever the injection module actually exports.

// Capture bounds, in px of the streamed JPEG. Frames ride the shared relay
// socket, so the cap is what keeps one frame tens of KB, not hundreds.
const MIN_CAP = 160; const MAX_CAP = 1440;
const MIN_FPS = 1; const MAX_FPS = 10; const DEFAULT_FPS = 5;
const MIN_QUALITY = 20; const MAX_QUALITY = 90; const DEFAULT_QUALITY = 50;
const MAX_TEXT = 2000;

const clamp = (n, lo, hi, dflt) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

const clampCaptureSize = (size) => ({
  width: clamp(size && size.width, MIN_CAP, MAX_CAP, MIN_CAP),
  height: clamp(size && size.height, MIN_CAP, MAX_CAP, MIN_CAP),
});

const clampFps = (n) => clamp(n, MIN_FPS, MAX_FPS, DEFAULT_FPS);
const clampQuality = (n) => clamp(n, MIN_QUALITY, MAX_QUALITY, DEFAULT_QUALITY);

// Abstract key names the phone may send → candidate nut-js Key enum names, in
// preference order. Candidates because the enum's spelling varies across
// versions (Enter vs Return, LeftSuper vs LeftWin) — the glue picks the first
// one the loaded module actually has, so a rename there can't break a key here.
const KEYS = {
  up: ['Up'], down: ['Down'], left: ['Left'], right: ['Right'],
  enter: ['Enter', 'Return'], escape: ['Escape'], backspace: ['Backspace'],
  tab: ['Tab'], space: ['Space'], delete: ['Delete'],
  home: ['Home'], end: ['End'], pageup: ['PageUp'], pagedown: ['PageDown'],
  ctrl: ['LeftControl'], alt: ['LeftAlt'], shift: ['LeftShift'],
  meta: ['LeftSuper', 'LeftWin', 'LeftCmd'],
};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i);
  KEYS[ch] = [ch.toUpperCase()];
}
for (let i = 0; i <= 9; i++) KEYS[String(i)] = [`Num${i}`, `Digit${i}`];
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = [`F${i}`];

const MODS = ['ctrl', 'alt', 'shift', 'meta'];

const keyCandidates = (name) => (typeof name === 'string' && KEYS[name.toLowerCase()]) || null;

// Unknown names dropped, canonical order kept — the glue presses them in list
// order and releases in reverse, so the order must be deterministic.
const normalizeMods = (mods) => (Array.isArray(mods)
  ? MODS.filter((m) => mods.some((x) => typeof x === 'string' && x.toLowerCase() === m))
  : []);

const BUTTONS = new Set(['left', 'right', 'middle']);
const inView = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const px = (n, size) => Math.min(size - 1, Math.max(0, Math.round(n * size)));

// One phone input item → the abstract ops that enact it at OS level. Coordinates
// arrive normalized 0..1 of the captured screen (the desktop is the only side
// that knows real pixels). Malformed items map to [] — network input is
// occasionally garbage, never fatal.
function toControlOps(item, screenW, screenH) {
  if (!item || typeof item !== 'object') return [];
  const at = () => ({ x: px(item.x, screenW), y: px(item.y, screenH) });

  if (item.k === 'move') {
    if (!inView(item.x) || !inView(item.y)) return [];
    return [{ op: 'move', ...at() }];
  }
  if (item.k === 'tap') {
    if (!inView(item.x) || !inView(item.y)) return [];
    const button = BUTTONS.has(item.button) ? item.button : 'left';
    const count = item.double === true ? 2 : 1;
    const mods = normalizeMods(item.mods);
    return [{ op: 'move', ...at() }, { op: 'click', button, count, mods }];
  }
  if (item.k === 'down' || item.k === 'up') {
    const button = BUTTONS.has(item.button) ? item.button : 'left';
    const ops = [];
    if (inView(item.x) && inView(item.y)) ops.push({ op: 'move', ...at() });
    ops.push({ op: item.k === 'down' ? 'button-down' : 'button-up', button });
    return ops;
  }
  if (item.k === 'scroll') {
    const dx = Math.round(Number(item.dx)); const dy = Math.round(Number(item.dy));
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return [];
    return [{ op: 'scroll', dx, dy }];
  }
  if (item.k === 'key') {
    if (!keyCandidates(item.key)) return [];
    const combo = [...normalizeMods(item.mods), item.key.toLowerCase()];
    return [{ op: 'combo', keys: combo }];
  }
  if (item.k === 'text') {
    if (typeof item.text !== 'string' || !item.text) return [];
    const mods = normalizeMods(item.mods);
    // A modified character is a combo (Ctrl+C), not typing; typing with
    // modifiers held would smear them across the whole string.
    if (mods.length && item.text.length === 1 && keyCandidates(item.text)) {
      return [{ op: 'combo', keys: [...mods, item.text.toLowerCase()] }];
    }
    return [{ op: 'type', text: item.text.slice(0, MAX_TEXT) }];
  }
  return [];
}

// Region-of-interest streaming: a zoomed-in phone asks for just the visible
// part of the screen (normalized 0..1 rect of the display). null means full
// screen — a near-full rect collapses to it so tiny float drift doesn't force
// the crop path.
const MIN_REGION = 0.02;
function clampRegion(r) {
  if (!r || typeof r !== 'object') return null;
  const nums = [r.x, r.y, r.w, r.h].map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const w = Math.min(1, Math.max(MIN_REGION, nums[2]));
  const h = Math.min(1, Math.max(MIN_REGION, nums[3]));
  if (w >= 0.995 && h >= 0.995) return null;
  return {
    x: Math.min(1 - w, Math.max(0, nums[0])),
    y: Math.min(1 - h, Math.max(0, nums[1])),
    w,
    h,
  };
}

// Size to capture the *whole* screen at so that cropping `region` out of it
// yields the requested output width — never above the display's native pixels,
// so zooming in sharpens until real density is reached, then stops.
function regionSourceSize(region, cap, screen) {
  if (!region || !screen.w || !screen.h) return null;
  const outW = Math.max(1, Math.min(cap.width, Math.round(region.w * screen.w)));
  const srcW = Math.min(screen.w, Math.max(1, Math.round(outW / region.w)));
  return { width: srcW, height: Math.max(1, Math.round((srcW * screen.h) / screen.w)) };
}

// The region as an integer crop rect inside a w×h image, kept in bounds.
function cropRect(region, w, h) {
  const width = Math.max(1, Math.min(w, Math.round(region.w * w)));
  const height = Math.max(1, Math.min(h, Math.round(region.h * h)));
  return {
    x: Math.min(w - width, Math.max(0, Math.round(region.x * w))),
    y: Math.min(h - height, Math.max(0, Math.round(region.y * h))),
    width,
    height,
  };
}

// Cursor position in display coords → normalized 0..1 of that display, clamped;
// null when outside it (another monitor) so the phone hides its overlay.
function normalizeCursor(point, bounds) {
  if (!point || !bounds || !bounds.width || !bounds.height) return null;
  const cx = (point.x - bounds.x) / bounds.width;
  const cy = (point.y - bounds.y) / bounds.height;
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return null;
  return { cx, cy };
}

module.exports = {
  clampCaptureSize, clampFps, clampQuality, keyCandidates, normalizeMods,
  toControlOps, normalizeCursor, clampRegion, regionSourceSize, cropRect,
  MIN_CAP, MAX_CAP, DEFAULT_FPS, DEFAULT_QUALITY, MAX_TEXT,
};
