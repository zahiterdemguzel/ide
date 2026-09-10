// Turning a Bash/MCP file change into the same replayable op an Edit tool would
// have produced. Pure (Electron-free), unit-tested in test/fs-content.test.js.
//
// Why this exists: agents increasingly edit files by running shell commands
// (`sed -i`, a heredoc, a script) instead of the Edit/Write tools. Those changes
// carry no payload we can read, so the tracker used to record only "this path
// changed" (`fileOps: 'add'`) — and a per-session commit then had to take the
// WHOLE file, sweeping in whatever another session or the user had also changed
// in it. Given the file's bytes before and after the tool call, we can recover
// the actual hunk and store it as an ordinary `edit` op, which:
//   - replays onto HEAD, so the commit contains only this session's change,
//   - inverts, so the change can be backed out individually,
//   - counts lines, so a Bash-editing session gets its "+124 −38" pill,
//   - claims the path with the same authority a text-edit tool has, which is how
//     two concurrent sessions touching one file stay separable.
// See sessions.js `applyFsDiff` for the caller and .claude/memory/architecture.md.

const crypto = require('crypto');

// How much of the dirty set we're willing to hold in memory per snapshot. Two
// baselines are live per session (per-tool and per-turn), so these are paid
// twice over. Past any of them the snapshot keeps codes only and the tracker
// degrades to its old whole-file behaviour — slower attribution beats a stalled
// hook or a session pinning hundreds of megabytes.
const LIMITS = {
  maxFiles: 200,             // dirty paths whose content we capture
  maxFileBytes: 256 * 1024,  // per file
  maxTotalBytes: 16 * 1024 * 1024,
};

// The biggest hunk worth storing as an `edit` op. Past this the op is no more
// precise than a whole-file write, and the write is cheaper to hold.
const MAX_HUNK_BYTES = 64 * 1024;

// Give up expanding context after this many lines: a file made of repeated
// identical lines can never make a hunk unique, and we must not scan it forever.
const MAX_EXPANSIONS = 200;

// Content identity for a snapshot entry. Replaces the old size+mtime stamp,
// which could not see a rewrite that preserved BOTH — exactly what
// `sed -i 's/foo/bar/'` does within one mtime tick, so that edit was read as
// "untouched by this tool" and dropped from the session entirely.
function hashContent(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

// A NUL byte in the first 8k is git's own binary heuristic. Binary files get no
// derived op — they stay whole-file `fileOps`, which is the only honest thing to
// do with bytes we can't diff as text.
function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function splitLines(s) {
  return s.split('\n');
}

// Occurrences of `needle` in `hay`, counted only far enough to answer "exactly
// one?" — the full count of a needle that appears thousands of times is of no
// interest and building that many split parts is the expensive part.
function occursOnce(hay, needle) {
  const first = hay.indexOf(needle);
  if (first < 0) return false;
  return hay.indexOf(needle, first + 1) < 0;
}

// The op describing `before` -> `after` for one file, or null when nothing
// changed. Returns an `edit` op (a minimal, uniquely-locatable hunk) when one can
// be derived, else a `write` op — which is exactly what the tracker did for every
// Bash change before, so the fallback is never a regression.
//
// The hunk is trimmed to whole lines that differ, then GROWN with surrounding
// context until it occurs exactly once in `before`. Uniqueness is not cosmetic:
// `replayEdits` locates a hunk with `indexOf`, so a hunk that matches in two
// places would be replayed onto the wrong one.
function deriveOp(before, after) {
  if (before === after) return null;
  // A file that didn't exist (or was empty) has no pre-image to anchor a hunk to.
  if (before === '') return { t: 'write', content: after };
  const a = splitLines(before), b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  for (let i = 0; i <= MAX_EXPANSIONS; i++) {
    const oldStr = a.slice(head, a.length - tail).join('\n');
    const newStr = b.slice(head, b.length - tail).join('\n');
    // Either side coming out empty means the hunk lost a newline to the
    // line-join: an empty `old` is a pure insertion, which replayEdits can only
    // append to the END of the file, and an empty `new` is a pure deletion that
    // would leave the deleted line's newline behind. One more line of context
    // fixes both, so such a hunk is grown like a non-unique one rather than
    // emitted. The exception is the whole file (no context left to take), where
    // an empty side is the literal truth.
    const whole = head === 0 && tail === 0;
    if (oldStr && (newStr || whole) && occursOnce(before, oldStr)) {
      if (oldStr.length + newStr.length > MAX_HUNK_BYTES) break;
      return { t: 'edit', old: oldStr, new: newStr, all: false };
    }
    if (whole) break; // no context left to take
    if (head > 0) head--;
    else tail--;
  }
  return { t: 'write', content: after };
}

module.exports = { LIMITS, MAX_HUNK_BYTES, hashContent, looksBinary, deriveOp };
