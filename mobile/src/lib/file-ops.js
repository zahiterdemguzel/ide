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
