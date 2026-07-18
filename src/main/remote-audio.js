// Remote audio: system ("what you hear") sound streamed to the phone. A hidden
// BrowserWindow captures loopback audio with getDisplayMedia — Electron's
// setDisplayMediaRequestHandler answers it with `audio: 'loopback'`, which
// Chromium supports on Windows only — and a MediaRecorder in that page emits
// ~250ms audio/webm;codecs=opus chunks over IPC. Main forwards them as
// `audio-chunk` events (watched — see STREAM_EVENTS, id 'main'); the phone
// feeds them into a MediaSource in a hidden WebView.
//
// Every `audio-open` recreates the capture window: a MediaRecorder stream is
// only decodable from its first chunk (the webm header), so a fresh recorder
// guarantees the phone that just asked gets a stream it can start decoding.

const { app, BrowserWindow, ipcMain } = require('electron');
const { handle, on } = require('./remote-bridge');

let broadcast = null; // injected by remote.js while remote access is enabled
// Monotonic across window recreations, never reset — the phone drops chunks
// with a seq at or below the last one seen (same lesson as browser-frame).
let seq = 0;
let win = null;

const alive = () => win && !win.isDestroyed();

function destroy() {
  if (alive()) win.destroy();
  win = null;
}

// The capture page. Internal data: URL with no remote content, so
// nodeIntegration is acceptable — it exists only to reach ipcRenderer.
// The video track is required to get a loopback grant but goes straight in
// the bin; only the audio tracks are recorded.
const PAGE = `<!doctype html><script>
const { ipcRenderer } = require('electron');
async function run() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    const tracks = stream.getAudioTracks();
    if (!tracks.length) { ipcRenderer.send('remote-audio-error', 'no system audio track'); return; }
    const rec = new MediaRecorder(new MediaStream(tracks), {
      mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000,
    });
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const buf = await e.data.arrayBuffer();
      ipcRenderer.send('remote-audio-chunk', Buffer.from(buf).toString('base64'));
    };
    rec.start(250);
  } catch (err) {
    ipcRenderer.send('remote-audio-error', String((err && err.message) || err));
  }
}
run();
</script>`;

function create() {
  destroy();
  win = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // A throttled hidden page would starve the recorder's timeslice cadence.
      backgroundThrottling: false,
      partition: 'remote-audio',
    },
  });
  // Loopback needs no picker and no real video source: an empty video answer
  // with audio:'loopback' hands the page the system-audio stream directly.
  win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ audio: 'loopback' });
  });
  win.webContents.on('render-process-gone', () => destroy());
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
}

handle('audio-open', async () => {
  if (process.platform !== 'win32') {
    return { id: 'main', ok: false, warning: 'System audio streaming is only supported on Windows.' };
  }
  create();
  return { id: 'main', ok: true };
});

on('audio-close', () => destroy());

ipcMain.on('remote-audio-chunk', (event, b64) => {
  if (!broadcast || !alive() || event.sender !== win.webContents) return;
  if (typeof b64 !== 'string' || !b64) return;
  seq += 1;
  broadcast('audio-chunk', { id: 'main', seq, b64 });
});

ipcMain.on('remote-audio-error', (event, message) => {
  if (!alive() || event.sender !== win.webContents) return;
  console.error('[remote-audio] capture failed:', message);
  destroy();
});

// remote.js injects the hub broadcast while enabled and clears it on disable.
function setBroadcast(fn) {
  broadcast = fn;
  if (!fn) destroy();
}

// The last phone left: nobody is listening, so stop capturing.
function onClientCount(count) {
  if (count === 0) destroy();
}

app.on('before-quit', destroy);

module.exports = { setBroadcast, onClientCount };
