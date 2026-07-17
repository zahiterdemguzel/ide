// Remote browser: the phone browses through an offscreen BrowserWindow on the
// desktop. Frames leave as base64 JPEG `browser-frame` events (watched — see
// STREAM_EVENTS), input arrives as normalized `browser-input` items and is
// injected with webContents.sendInputEvent. Offscreen rendering is push-based:
// the `paint` event fires only on dirty frames (software compositing on
// Windows), and setFrameRate caps it; paint goes quiet on an idle page, so
// invalidate() is called after loads and resizes to force a first frame.
//
// One instance per desktop window (id 'main'): the feature mirrors one phone
// driving one page, and a second watcher simply sees the same frames.

const { BrowserWindow, app } = require('electron');
const { handle, on } = require('./remote-bridge');
const {
  normalizeBrowserUrl, clampViewport, toInputEvents, createFrameGate, uaForMode,
} = require('./remote-browser-lib');

const DEFAULT_URL = 'about:blank';
const DEFAULT_QUALITY = 55; // JPEG quality — bandwidth over fidelity on a phone screen
const MAX_FPS = 15;

let broadcast = null; // injected by remote.js while remote access is enabled
let win = null;
let seq = 0;
let quality = DEFAULT_QUALITY;
let gate = createFrameGate({ maxFps: 8 });
let trailing = null; // timer holding the last frame of a paint burst
let lastImage = null;
let currentMode = 'desktop';

const alive = () => win && !win.isDestroyed();

function emitFrame(image) {
  if (!broadcast || !alive()) return;
  const size = image.getSize();
  seq += 1;
  broadcast('browser-frame', {
    id: 'main', seq, w: size.width, h: size.height, b64: image.toJPEG(quality).toString('base64'),
  });
}

// Gate + trailing edge: send now if the window is open, otherwise hold the
// newest frame and flush it when the window opens — a burst ends with its last
// frame on the phone, not its first.
function onPaint(_event, _dirty, image) {
  if (gate.shouldSend()) {
    gate.mark();
    emitFrame(image);
    return;
  }
  lastImage = image;
  if (trailing) return;
  trailing = setTimeout(() => {
    trailing = null;
    if (lastImage) { gate.mark(); emitFrame(lastImage); lastImage = null; }
  }, gate.pending());
}

function emitState() {
  if (!broadcast || !alive()) return;
  const wc = win.webContents;
  broadcast('browser-state', {
    id: 'main',
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  });
}

function destroy() {
  if (trailing) { clearTimeout(trailing); trailing = null; }
  lastImage = null;
  if (alive()) win.destroy();
  win = null;
}

// No device-metrics emulation at all: BOTH ways of getting F12 device mode
// crash Electron's main process when the target window is *offscreen* —
// webContents.debugger/CDP (electron#27768, #14759) and, verified empirically
// on Electron 31/Windows, the public enableDeviceEmulation too (crashpad "not
// connected", instant process death on the call). Mobile mode is therefore
// only the phone UA string (uaForMode + setUserAgent) plus the phone-sized
// viewport, which is enough for sites to serve their mobile layout.
function create({ width, height, maxFps, mode }) {
  destroy();
  seq = 0;
  const fps = Math.min(Math.max(1, maxFps || 8), MAX_FPS);
  gate = createFrameGate({ maxFps: fps });
  win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:remote-browser',
    },
  });
  win.setContentSize(width, height);
  currentMode = mode === 'mobile' ? 'mobile' : 'desktop';
  // Mobile mode masquerades as a phone so sites serve their mobile layout;
  // set before loadURL, since the UA only takes effect on the next navigation.
  const ua = uaForMode(currentMode);
  if (ua) win.webContents.setUserAgent(ua);
  win.webContents.setFrameRate(fps);
  // If the offscreen renderer ever dies, log it and tear down instead of
  // leaving a dead window that emits nothing — the phone re-opens on next focus.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[remote-browser] render process gone:', details && details.reason);
    destroy();
  });
  win.webContents.on('paint', onPaint);
  const state = () => emitState();
  win.webContents.on('did-navigate', state);
  win.webContents.on('did-navigate-in-page', state);
  win.webContents.on('page-title-updated', state);
  win.webContents.on('did-start-loading', state);
  win.webContents.on('did-stop-loading', () => {
    emitState();
    if (alive()) win.webContents.invalidate();
  });
  // Scrollbars are dead pixels on a phone-sized frame: scrolling is driven by
  // wheel events from the phone's drags, never by the bar. insertCSS lasts only
  // for the current document, so re-inject per navigation (frames included —
  // an embedded scroller's bar is just as wasted).
  win.webContents.on('did-frame-finish-load', () => {
    if (alive()) win.webContents.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => {});
  });
  // A page must not open real desktop windows; navigate the same view instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (normalizeBrowserUrl(url)) win.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
}

handle('browser-open', (_event, args = {}) => {
  const { width, height } = clampViewport(args);
  if (typeof args.quality === 'number') quality = Math.min(90, Math.max(20, Math.round(args.quality)));
  const url = normalizeBrowserUrl(args.url) || DEFAULT_URL;
  create({ width, height, maxFps: args.maxFps, mode: args.mode });
  win.webContents.loadURL(url).catch(() => {});
  const wc = win.webContents;
  return {
    id: 'main',
    url,
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  };
});

on('browser-navigate', (_event, { url } = {}) => {
  const target = normalizeBrowserUrl(url);
  if (target && alive()) win.webContents.loadURL(target).catch(() => {});
});

on('browser-input', (_event, { events } = {}) => {
  if (!alive() || !Array.isArray(events)) return;
  const [w, h] = win.getContentSize();
  for (const item of events) {
    for (const descriptor of toInputEvents(item, w, h)) {
      win.webContents.sendInputEvent(descriptor);
    }
  }
});

on('browser-resize', (_event, args = {}) => {
  if (!alive()) return;
  const { width, height } = clampViewport(args);
  if (typeof args.quality === 'number') quality = Math.min(90, Math.max(20, Math.round(args.quality)));
  win.setContentSize(width, height);
  win.webContents.invalidate();
});

on('browser-nav', (_event, { action } = {}) => {
  if (!alive()) return;
  const wc = win.webContents;
  if (action === 'back') wc.goBack();
  else if (action === 'forward') wc.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
});

on('browser-close', () => destroy());

// remote.js injects the hub broadcast while enabled and clears it on disable —
// frames have nowhere to go without a hub, so the window dies with the service.
function setBroadcast(fn) {
  broadcast = fn;
  if (!fn) destroy();
}

// The last phone left: nobody is watching, so stop rendering. The phone
// re-issues browser-open when its Browser tab regains a connection.
function onClientCount(count) {
  if (count === 0) destroy();
}

app.on('before-quit', destroy);

module.exports = { setBroadcast, onClientCount };
