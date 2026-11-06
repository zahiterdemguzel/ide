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

/** The media type to open a downloaded file with; generic bytes when unknown. @param {string} name */
export function mimeForName(name) {
  const ext = extensionOf(name);
  return Object.prototype.hasOwnProperty.call(BINARY_MIME, ext) ? BINARY_MIME[ext] : 'application/octet-stream';
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
