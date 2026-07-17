// Remote desktop control: the phone sees the whole screen and drives the OS.
// Frames leave as base64 JPEG `screen-frame` events (watched — see
// STREAM_EVENTS), captured by polling desktopCapturer on the selected display;
// input arrives as normalized `control-input` items and is injected at OS level
// through @nut-tree-fork/nut-js (N-API, so it loads in Electron without a
// rebuild — which `npmRebuild: false` in the builder config requires).
//
// The module degrades: if nut-js fails to load (missing prebuild, macOS
// Accessibility not granted) the screen still streams and control-open says why
// input is off, instead of the feature dying whole.

const {
  app, desktopCapturer, nativeImage, screen, systemPreferences,
} = require('electron');
const { handle, on } = require('./remote-bridge');
const {
  clampCaptureSize, clampFps, clampQuality, keyCandidates, toControlOps, normalizeCursor,
} = require('./remote-control-lib');

let broadcast = null; // injected by remote.js while remote access is enabled
let timer = null;
let seq = 0;
let capSize = { width: 480, height: 300 };
let quality = 50;
let capturing = false; // a slow getSources call must not stack the next tick on itself
let lastJpeg = null;
let lastCursorKey = '';
let screenPx = { w: 0, h: 0 }; // physical px of the selected display
let targets = []; // capturable displays: [{ id, sourceId, display, primary, label }]
let current = null; // selected target from `targets`
let injectOrigin = { x: 0, y: 0 }; // selected display's top-left in nut-js's virtual-desktop px

let nut = null; // { mouse, keyboard, screen, Key, Button } once loaded
let nutError = null;
let queue = Promise.resolve(); // input is order-sensitive: one op at a time

function loadNut() {
  if (nut || nutError) return;
  try {
    const mod = require('@nut-tree-fork/nut-js');
    // Not 0: a zero gap collapses modifier-down and key-down into one instant, so
    // the OS never sees the modifier held when the key fires (Ctrl+C, Shift+x,
    // Win+D silently do nothing) and some apps ignore a zero-gap click outright.
    // A few ms per step is imperceptible and makes chords and clicks register.
    mod.mouse.config.autoDelayMs = 12;
    mod.keyboard.config.autoDelayMs = 4;
    nut = mod;
  } catch (err) {
    nutError = String((err && err.message) || err);
  }
}

// First nut-js Key the loaded module actually exports for an abstract name.
function resolveKey(name) {
  const cands = keyCandidates(name);
  if (!cands) return null;
  for (const c of cands) if (c in nut.Key) return nut.Key[c];
  return null;
}

const NUT_BUTTONS = { left: 'LEFT', right: 'RIGHT', middle: 'MIDDLE' };

async function runOp(op) {
  const { mouse, keyboard, Point, Button } = nut;
  if (op.op === 'move') return mouse.setPosition(new Point(op.x + injectOrigin.x, op.y + injectOrigin.y));
  if (op.op === 'click') {
    const button = Button[NUT_BUTTONS[op.button]];
    const mods = op.mods.map(resolveKey).filter((k) => k !== null);
    if (mods.length) await keyboard.pressKey(...mods);
    if (op.count === 2) await mouse.doubleClick(button);
    else await mouse.click(button);
    if (mods.length) await keyboard.releaseKey(...mods.reverse());
    return undefined;
  }
  if (op.op === 'button-down') return mouse.pressButton(Button[NUT_BUTTONS[op.button]]);
  if (op.op === 'button-up') return mouse.releaseButton(Button[NUT_BUTTONS[op.button]]);
  if (op.op === 'scroll') {
    // Content follows the finger: a drag down (dy > 0) reveals what is above,
    // which is a wheel-up. Same inversion horizontally.
    if (op.dy > 0) await mouse.scrollUp(op.dy);
    else if (op.dy < 0) await mouse.scrollDown(-op.dy);
    if (op.dx > 0) await mouse.scrollLeft(op.dx);
    else if (op.dx < 0) await mouse.scrollRight(-op.dx);
    return undefined;
  }
  if (op.op === 'combo') {
    const keys = op.keys.map(resolveKey).filter((k) => k !== null);
    if (keys.length !== op.keys.length) return undefined; // a combo missing a key must not fire the rest
    await keyboard.pressKey(...keys);
    await keyboard.releaseKey(...keys.reverse());
    return undefined;
  }
  if (op.op === 'type') return keyboard.type(op.text);
  return undefined;
}

// nut-js's native layer, used as a second capture engine: on some Windows
// setups (hybrid iGPU/dGPU laptops) Chromium's desktopCapturer exposes a source
// for only one of the displays, but libnut's GDI capture can grab the OS
// primary. Loaded lazily and only if needed; capture stays desktopCapturer-only
// where it covers every display.
let libnut = null;
let libnutTried = false;
function loadLibnut() {
  if (libnutTried) return libnut;
  libnutTried = true;
  const pkg = { win32: 'libnut-win32', darwin: 'libnut-darwin', linux: 'libnut-linux' }[process.platform];
  try {
    const mod = require(`@nut-tree-fork/${pkg}`);
    if (mod && mod.screen && typeof mod.screen.capture === 'function') libnut = mod;
  } catch { libnut = null; }
  return libnut;
}

// The displays we can actually stream, each paired with its capture engine.
// desktopCapturer sources are preferred; a display it misses gets a libnut
// target if libnut can reach it (its GDI capture only spans the OS primary).
// A display neither engine covers is left out entirely — offering it would only
// stream a *different* screen under its coordinates. The label tells monitors
// apart (index, primary flag, size) without the phone knowing geometry.
async function captureTargets() {
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch { sources = []; }
  const all = screen.getAllDisplays();
  const primaryId = String(screen.getPrimaryDisplay().id);
  const byId = new Map(all.map((d) => [String(d.id), d]));
  const list = sources.map((s, i) => {
    // Pair by the display the source names; positional fallback for the rare
    // source that carries no display_id (older Electron / some platforms).
    const d = byId.get(String(s.display_id)) || all[i] || screen.getPrimaryDisplay();
    return { id: String(d.id), kind: 'source', sourceId: s.id, display: d, primary: String(d.id) === primaryId };
  });
  const covered = new Set(list.map((t) => t.id));
  if (!covered.has(primaryId) && loadLibnut()) {
    const d = screen.getPrimaryDisplay();
    list.push({ id: primaryId, kind: 'libnut', sourceId: null, display: d, primary: true });
  }
  list.sort((a, b) => Number(b.primary) - Number(a.primary));
  return list.map((t, i) => ({
    ...t,
    label: `Display ${i + 1}${t.primary ? ' · primary' : ''} · ${t.display.size.width}×${t.display.size.height}`,
  }));
}

// One frame of the selected display via libnut's GDI capture, downscaled to the
// requested capture box. Runs on demand only — nothing is grabbed for displays
// the phone didn't choose.
function libnutFrame() {
  const bmp = libnut.screen.capture();
  const full = nativeImage.createFromBitmap(bmp.image, { width: bmp.width, height: bmp.height });
  const scale = Math.min(capSize.width / bmp.width, capSize.height / bmp.height, 1);
  return full.resize({ width: Math.max(1, Math.round(bmp.width * scale)) });
}

// Point capture + injection at one capturable target. nut-js injects in physical
// px across the whole virtual desktop, so injectOrigin offsets this display into
// that shared space; screenPx is its own physical size. Default (no id, or an id
// with no source) falls to the primary target, else the first capturable one —
// never a display we cannot actually stream.
function selectTarget(id) {
  current = targets.find((t) => t.id === String(id))
    || targets.find((t) => t.primary) || targets[0] || null;
  const d = current ? current.display : screen.getPrimaryDisplay();
  injectOrigin = {
    x: Math.round(d.bounds.x * d.scaleFactor),
    y: Math.round(d.bounds.y * d.scaleFactor),
  };
  screenPx = {
    w: Math.round(d.bounds.width * d.scaleFactor),
    h: Math.round(d.bounds.height * d.scaleFactor),
  };
  // bounds×scale can land 1px off the true mode (fractional logical sizes);
  // libnut knows the primary's exact physical size, so trust it there.
  if (current && current.kind === 'libnut' && libnut) {
    const s = libnut.getScreenSize();
    if (s && s.width) screenPx = { w: s.width, h: s.height };
  }
}

async function captureFrame() {
  if (!current) return;
  let image;
  if (current.kind === 'libnut') {
    image = libnutFrame();
  } else {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: capSize,
    });
    // Match the selected source exactly — no fall back to another display, or
    // the phone would see one screen while taps land on another.
    const source = sources.find((s) => s.id === current.sourceId)
      || sources.find((s) => s.display_id && s.display_id === String(current.display.id));
    if (!source) return;
    image = source.thumbnail;
  }
  if (!image || image.isEmpty()) return;
  const jpeg = image.toJPEG(quality);
  const cursor = normalizeCursor(screen.getCursorScreenPoint(), current.display.bounds);
  // A still screen must not re-send the same bytes every tick — but the cursor
  // moves between identical frames, so "same" covers both image and cursor.
  const cursorKey = cursor ? `${cursor.cx.toFixed(3)},${cursor.cy.toFixed(3)}` : 'off';
  const same = lastJpeg && jpeg.equals(lastJpeg) && cursorKey === lastCursorKey;
  lastJpeg = jpeg;
  lastCursorKey = cursorKey;
  if (same) return;
  const size = image.getSize();
  seq += 1;
  if (!broadcast) return;
  broadcast('screen-frame', {
    id: 'main', seq, w: size.width, h: size.height, cursor, b64: jpeg.toString('base64'),
  });
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  lastJpeg = null;
  lastCursorKey = '';
  capturing = false;
}

function start(fps) {
  stop();
  seq = 0;
  timer = setInterval(() => {
    if (!broadcast || capturing) return;
    capturing = true;
    captureFrame().catch(() => {}).finally(() => { capturing = false; });
  }, Math.floor(1000 / fps));
}

// macOS gates both halves behind system permissions; say so up front instead of
// streaming black frames at a phone that can't tell why.
function darwinWarnings() {
  const warnings = [];
  if (process.platform !== 'darwin') return warnings;
  try {
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      warnings.push('Grant Screen Recording permission to this app in System Settings → Privacy & Security, then relaunch.');
    }
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      warnings.push('Grant Accessibility permission to this app in System Settings → Privacy & Security, then relaunch.');
    }
  } catch { /* older Electron/macOS — let it try */ }
  return warnings;
}

handle('control-open', async (_event, args = {}) => {
  loadNut();
  capSize = clampCaptureSize(args);
  quality = clampQuality(args.quality);
  targets = await captureTargets();
  selectTarget(args.display); // undefined → primary/first capturable
  start(clampFps(args.maxFps));
  const warnings = darwinWarnings();
  if (nutError) warnings.push(`Input injection unavailable: ${nutError}`);
  return {
    id: 'main',
    platform: process.platform,
    screenW: screenPx.w,
    screenH: screenPx.h,
    input: !!nut,
    warnings,
    displays: targets.map(({ id, label, primary }) => ({ id, label, primary })),
    display: current ? current.id : null,
  };
});

on('control-input', (_event, { events } = {}) => {
  if (!nut || !Array.isArray(events) || !screenPx.w) return;
  for (const item of events) {
    for (const op of toControlOps(item, screenPx.w, screenPx.h)) {
      queue = queue.then(() => runOp(op)).catch(() => {});
    }
  }
});

on('control-close', () => stop());

// remote.js injects the hub broadcast while enabled and clears it on disable —
// frames have nowhere to go without a hub.
function setBroadcast(fn) {
  broadcast = fn;
  if (!fn) stop();
}

// The last phone left: nobody is watching, so stop capturing. The phone
// re-issues control-open when its Control tab regains a connection.
function onClientCount(count) {
  if (count === 0) stop();
}

app.on('before-quit', stop);

module.exports = { setBroadcast, onClientCount };
