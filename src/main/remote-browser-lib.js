// Pure logic behind the remote browser (src/main/remote-browser.js): URL
// normalization, viewport clamping, phone-input → Electron sendInputEvent
// mapping, and the frame-rate gate. No Electron — see .claude/memory/testing.md.

// Viewport bounds. The phone sends its layout size in CSS px; anything outside
// these is a bug or an attack, so clamp rather than trust.
const MIN_W = 320; const MAX_W = 1600;
const MIN_H = 320; const MAX_H = 2560;

// What a typed address may load. file:/javascript:/about: would reach the
// desktop's disk or the browser window itself; only the web is on offer.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// User-typed text → a loadable URL, or null. Bare hosts get https://; a bare
// word with no dot is treated as garbage rather than guessed into a search.
function normalizeBrowserUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  // '://' (not just ':') marks an explicit scheme — 'localhost:3000' is a
  // host:port, not a 'localhost:' protocol. Scheme-only forms like
  // 'javascript:...' still parse below and fail the protocol allowlist.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:[^0-9]/i.test(text)
    ? text : `https://${text}`;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  return url.toString();
}

function clampViewport(size) {
  const w = Math.round(Number(size && size.width));
  const h = Math.round(Number(size && size.height));
  return {
    width: Math.min(MAX_W, Math.max(MIN_W, Number.isFinite(w) ? w : MIN_W)),
    height: Math.min(MAX_H, Math.max(MIN_H, Number.isFinite(h) ? h : MIN_H)),
  };
}

const inView = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

// One phone input item → the Electron sendInputEvent descriptors that enact it.
// Coordinates arrive normalized 0..1 (the desktop is the only side that knows
// the viewport size, so a resize can never race a tap). Malformed items map to
// [] — network input is expected to be occasionally garbage, never fatal.
function toInputEvents(item, viewW, viewH) {
  if (!item || typeof item !== 'object') return [];
  if (item.k === 'tap') {
    if (!inView(item.x) || !inView(item.y)) return [];
    const x = Math.round(item.x * viewW);
    const y = Math.round(item.y * viewH);
    return [
      { type: 'mouseDown', x, y, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x, y, button: 'left', clickCount: 1 },
    ];
  }
  if (item.k === 'scroll') {
    if (!inView(item.x) || !inView(item.y)) return [];
    const dx = Number(item.dx); const dy = Number(item.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [];
    // A finger dragging up means "show me what's below": content follows the
    // finger, so the wheel delta is the drag delta as-is (deltaY > 0 scrolls up
    // in Electron's coordinate space, matching a positive finger drag down).
    return [{
      type: 'mouseWheel',
      x: Math.round(item.x * viewW),
      y: Math.round(item.y * viewH),
      deltaX: Math.round(dx),
      deltaY: Math.round(dy),
    }];
  }
  if (item.k === 'text') {
    if (typeof item.text !== 'string' || !item.text) return [];
    return [...item.text].map((chr) => ({ type: 'char', keyCode: chr }));
  }
  if (item.k === 'key') {
    if (typeof item.key !== 'string' || !item.key) return [];
    return [
      { type: 'keyDown', keyCode: item.key },
      { type: 'keyUp', keyCode: item.key },
    ];
  }
  return [];
}

// Paces frame sends to maxFps with a trailing edge: a paint burst collapses to
// one frame per interval, and the *last* frame of the burst is always delivered
// (pending() says how long to wait before flushing it). Clock injected for tests.
function createFrameGate({ maxFps = 8, now = Date.now } = {}) {
  const interval = Math.max(1, Math.floor(1000 / Math.max(1, maxFps)));
  let lastSent = -Infinity;
  return {
    interval,
    shouldSend() { return now() - lastSent >= interval; },
    mark() { lastSent = now(); },
    // ms until the next send window; 0 if it is open now.
    pending() { return Math.max(0, interval - (now() - lastSent)); },
  };
}

// What the page believes it runs on. Mobile mode pairs the phone-sized
// viewport with a phone UA so sites serve their mobile layout; desktop mode
// (or anything unrecognized) keeps Electron's own desktop-Chrome UA (null =
// don't override).
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

function uaForMode(mode) {
  return mode === 'mobile' ? MOBILE_UA : null;
}

// Device-metrics emulation (Chrome's F12 device mode) is deliberately absent:
// both webContents.debugger/CDP (electron#27768, #14759) and the public
// enableDeviceEmulation crash Electron's main process when the target window
// is offscreen (verified on Electron 31/Windows). See remote-browser.js.

module.exports = {
  normalizeBrowserUrl, clampViewport, toInputEvents, createFrameGate, uaForMode,
  MIN_W, MAX_W, MIN_H, MAX_H,
};
