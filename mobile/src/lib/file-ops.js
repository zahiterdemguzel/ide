// Pure helpers behind the Files tab: repo-relative path math, the name check the
// New file / New folder / Rename prompts run before asking the desktop, and the
// latest-wins queue folder listings go through. Plain JS rather than TypeScript so
// the repo's node:test suite can import it — see test/mobile-file-ops.test.mjs.

/** @param {string} dir @param {string} name */
export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

/** @param {string} rel */
export function parentPath(rel) {
  return rel.split('/').slice(0, -1).join('/');
}

/** @param {string} rel */
export function baseName(rel) {
  const parts = rel.split('/');
  return parts[parts.length - 1];
}

// Characters no mainstream filesystem accepts in a name (Windows is the strictest,
// and the desktop this phone drives may well be Windows).
// Control characters (tab, newline…) are checked by code point rather than in the
// regex, which keeps lint's no-control-regex quiet without hiding them.
const FORBIDDEN_CHARS = /[<>:"|?*\\]/;
const hasControlChar = (s) => [...s].some((ch) => ch.charCodeAt(0) < 0x20);

/**
 * Check a name typed into a prompt. `nested` allows `a/b.txt` — the desktop's
 * create-file / create-folder make the parent folders, exactly as its own New file
 * prompt does — while a rename keeps the entry in its folder, so no `/`.
 *
 * @param {string} raw
 * @param {{ nested?: boolean }} [opts]
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateEntryName(raw, { nested = false } = {}) {
  const name = (raw ?? '').trim();
  if (!name) return { ok: false, error: 'Enter a name.' };
  if (!nested && name.includes('/')) return { ok: false, error: 'A name can’t contain “/”.' };
  if (FORBIDDEN_CHARS.test(name) || hasControlChar(name)) return { ok: false, error: 'That name has characters a file name can’t use.' };
  const segments = name.split('/');
  if (segments.some((s) => !s)) return { ok: false, error: 'A path can’t start, end or have an empty “/” part.' };
  if (segments.some((s) => s === '.' || s === '..')) return { ok: false, error: '“.” and “..” aren’t valid names.' };
  return { ok: true, name };
}

/**
 * Where `rel` lands when renamed to `newName` — same folder, new last segment.
 * @param {string} rel @param {string} newName
 */
export function renamedPath(rel, newName) {
  return joinPath(parentPath(rel), newName);
}

/**
 * Serialises calls to `run` with latest-wins coalescing: at most one run in
 * flight and at most one waiting; a request made while one is in flight replaces
 * whatever was waiting rather than being dropped. That's what a folder tap needs —
 * the old `busy` guard ignored a tap made during a watcher-triggered re-list, so
 * the tap silently did nothing — while still collapsing a burst of tree-watcher
 * events into one extra listing.
 *
 * `run(arg, superseded)` gets a `superseded()` probe: true once a newer request is
 * waiting, so a run can skip applying a result that is about to be replaced.
 *
 * @template T
 * @param {(arg: T, superseded: () => boolean) => Promise<void>} run
 */
export function createLatestQueue(run) {
  let running = false;
  /** @type {{ arg: T } | null} */
  let waiting = null;
  /** @type {Promise<void>} */
  let idle = Promise.resolve();
  /** @type {(() => void) | null} */
  let markIdle = null;

  /** @param {T} arg */
  const drain = async (arg) => {
    running = true;
    try {
      await run(arg, () => waiting !== null);
    } catch {
      // The caller's run reports its own failures; a throw must not wedge the queue.
    }
    if (waiting) {
      const next = waiting.arg;
      waiting = null;
      return drain(next);
    }
    running = false;
    markIdle?.();
  };

  return {
    /** @param {T} arg */
    request(arg) {
      if (running) { waiting = { arg }; return; }
      idle = new Promise((resolve) => { markIdle = () => resolve(undefined); });
      drain(arg);
    },
    /** Resolves once nothing is in flight or waiting. */
    whenIdle() { return idle; },
    get busy() { return running; },
  };
}

// --- Text vs binary ------------------------------------------------------------
//
// The desktop's `read-text` decodes *any* file as UTF-8 and answers ok, so a PNG or
// a zip comes back as mojibake rather than as an error. The phone has to tell the
// two apart itself — by extension first (no point shipping a 10MB image over the
// socket just to discard it), then by the null byte the desktop editor also keys on.

// Media types for formats the phone hands to another app. The type is what lets
// Android's "Open with" offer a fitting app (a gallery for a PNG, a PDF reader…).
const BINARY_MIME = {
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic',
  tif: 'image/tiff', tiff: 'image/tiff', psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', tar: 'application/x-tar',
  jar: 'application/java-archive', ipa: 'application/octet-stream',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  glb: 'model/gltf-binary', fbx: 'application/octet-stream', blend: 'application/octet-stream',
  exe: 'application/octet-stream', dll: 'application/octet-stream', so: 'application/octet-stream',
  bin: 'application/octet-stream', wasm: 'application/wasm', db: 'application/octet-stream',
  sqlite: 'application/octet-stream', pck: 'application/octet-stream',
};

/** Lower-cased extension of a file name, without the dot ('' when none). @param {string} name */
export function extensionOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True for formats that are never text, so the viewer is skipped outright. @param {string} name */
export function isKnownBinaryName(name) {
  return Object.prototype.hasOwnProperty.call(BINARY_MIME, extensionOf(name));
}

// Text formats that still deserve a real media type when handed to another app or
// saved to the phone (an .svg should offer image apps, a .txt a text editor). Kept
// apart from BINARY_MIME because these must still go through read-text.
const TEXT_MIME = {
  svg: 'image/svg+xml', txt: 'text/plain', log: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', xml: 'text/xml', html: 'text/html', htm: 'text/html',
};

const hasOwn = (table, key) => Object.prototype.hasOwnProperty.call(table, key);

/** The media type to open a downloaded file with; generic bytes when unknown. @param {string} name */
export function mimeForName(name) {
  const ext = extensionOf(name);
  if (hasOwn(BINARY_MIME, ext)) return BINARY_MIME[ext];
  if (hasOwn(TEXT_MIME, ext)) return TEXT_MIME[ext];
  return 'application/octet-stream';
}

// --- In-app preview ------------------------------------------------------------
//
// Images, SVGs and PDFs are shown on the phone itself (FilePreviewScreen) rather
// than bounced to another app. Everything renders in a WebView from an HTML page
// built here, which gives pinch-zoom on both platforms and one code path.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);

/**
 * How the phone previews a file in-app, or null when it can't (open it elsewhere).
 * @param {string} name
 * @returns {'image' | 'svg' | 'pdf' | null}
 */
export function previewKindFor(name) {
  const ext = extensionOf(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  return null;
}

// Above this the base64 page would strain the JS↔WebView bridge; the preview
// offers "Open in another app" / "Save to phone" instead.
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

// pdf.js 3.x is the last line shipped as a classic (non-module) script, which every
// Android System WebView still in the wild can run. Loaded from the CDN, so a PDF
// preview needs the phone online; the page reports failure and the screen falls
// back to the other-app actions.
export const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

/** Human-readable size: 812 B, 14.2 KB, 3.1 MB. @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

// A checkerboard behind the picture, so transparent icons and SVG strokes in the
// page's own dark colour stay visible.
const PAGE_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=8, user-scalable=yes">`;

/**
 * The page that shows one image or SVG, centred and pinch-zoomable. The picture is
 * an <img> fed a data URL, so an SVG's scripts never run.
 *
 * @param {{ kind: 'image' | 'svg', base64: string, name: string }} file
 */
export function imagePreviewHtml({ kind, base64, name }) {
  const mime = mimeForName(name);
  // An SVG icon is often 16–24 units with no intrinsic size worth keeping: scale it
  // up to fill the view. A bitmap keeps its own pixels, only shrunk to fit.
  const sizing = kind === 'svg'
    ? 'width: min(82vw, 82vh); height: min(82vw, 82vh); object-fit: contain;'
    : 'max-width: 100%; max-height: 100vh; object-fit: contain;';
  return `<!doctype html><html><head>${PAGE_HEAD}<style>
html, body { margin: 0; height: 100%; background: #0d1117; }
body { display: flex; align-items: center; justify-content: center; }
img { ${sizing} display: block;
  background: repeating-conic-gradient(#2d333b 0% 25%, #1c2128 0% 50%) 50% / 16px 16px; }
</style></head><body>
<img alt="${escapeHtml(name)}" src="data:${mime};base64,${base64}"
  onload="window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}))"
  onerror="window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'This image could not be decoded on the phone.'}))">
</body></html>`;
}

/**
 * The page that renders a PDF with pdf.js, one canvas per page at the screen's
 * pixel density, pages drawn lazily as they scroll near. Posts {type:'ready',pages}
 * or {type:'error',message} to the WebView host.
 *
 * @param {{ base64: string }} file
 */
export function pdfPreviewHtml({ base64 }) {
  // The bytes sit in an inert <script> block rather than a JS string literal, so a
  // 30MB document never goes through the JavaScript parser.
  return `<!doctype html><html><head>${PAGE_HEAD}<style>
html, body { margin: 0; background: #0d1117; color: #8b949e; font: 14px sans-serif; }
.page { display: block; margin: 8px auto; background: #fff; box-shadow: 0 1px 4px #0008; }
#status { padding: 24px; text-align: center; }
</style></head><body>
<div id="status">Loading PDF…</div>
<script type="application/octet-stream" id="pdf-data">${base64}</script>
<script src="${PDFJS_BASE}/pdf.min.js"></script>
<script>
(function () {
  function post(msg) { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  function fail(message) { document.getElementById('status').textContent = message; post({ type: 'error', message: message }); }
  if (!window.pdfjsLib) { fail('The PDF viewer could not load — the phone needs internet access to preview PDFs.'); return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDFJS_BASE}/pdf.worker.min.js';
  var raw = atob(document.getElementById('pdf-data').textContent.trim());
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
    document.getElementById('status').remove();
    var ratio = window.devicePixelRatio || 1;
    var width = document.documentElement.clientWidth - 16;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || entry.target.dataset.drawn) return;
        entry.target.dataset.drawn = '1';
        drawPage(entry.target);
      });
    }, { rootMargin: '1000px 0px' });
    function drawPage(canvas) {
      pdf.getPage(Number(canvas.dataset.page)).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: (width / base.width) * ratio });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.height = Math.round(viewport.height / ratio) + 'px'; // a page shaped unlike page 1
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
      }).catch(function (e) { post({ type: 'error', message: String(e && e.message || e) }); });
    }
    // Reserve every page's height up front from page 1's shape, so the scrollbar
    // is right and lazy drawing doesn't make the document jump.
    pdf.getPage(1).then(function (first) {
      var shape = first.getViewport({ scale: 1 });
      for (var n = 1; n <= pdf.numPages; n++) {
        var canvas = document.createElement('canvas');
        canvas.className = 'page';
        canvas.dataset.page = String(n);
        canvas.style.width = width + 'px';
        canvas.style.height = Math.round(width * shape.height / shape.width) + 'px';
        document.body.appendChild(canvas);
        observer.observe(canvas);
      }
      post({ type: 'ready', pages: pdf.numPages });
    });
  }).catch(function (e) {
    fail(e && e.name === 'PasswordException' ? 'This PDF is password-protected.' : 'This PDF could not be read: ' + (e && e.message || e));
  });
})();
</script>
</body></html>`;
}

/**
 * The text of a `read-text` reply, or null when it isn't viewable text — a failed
 * read, or bytes containing a null (the desktop decoded a binary as UTF-8).
 *
 * @param {{ ok?: boolean, text?: string } | null | undefined} reply
 * @returns {string | null}
 */
export function textFromReadReply(reply) {
  if (!reply?.ok || typeof reply.text !== 'string') return null;
  return reply.text.includes('\u0000') ? null : reply.text;
}
