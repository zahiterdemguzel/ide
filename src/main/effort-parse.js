// Pure (Electron-free) helper that watches a session's raw PTY input for a
// `/effort <level>` slash command the user typed straight into the chat, so the
// session-bar effort badge can track a change made from the terminal (not just via
// the badge's own dropdown). Kept apart from the IPC glue in sessions.js so it stays
// unit-tested (test/effort-parse.test.js).
//
// It maintains a per-session line buffer across input chunks: printable bytes
// accumulate, backspace edits the tail, Enter evaluates the line and resets it, and
// line-kill keys (Ctrl-C / Ctrl-U) clear it. Terminal escape sequences (arrow keys,
// etc.) are swallowed so a cursor move mid-line neither matches nor corrupts the
// buffer. Only a line that is *exactly* the command matches, so stray prose never
// triggers a false positive. `/effort` with no level (the interactive slider) can't
// be resolved from the input stream, so it's deliberately not detected.

const EFFORT_RE = /^\/effort\s+(auto|low|medium|high|xhigh|max)$/i;
const MAX_BUF = 256; // cap so a long-lived session can't grow an unbounded buffer

// Advance past a terminal escape sequence starting at data[i] (which is ESC).
// Handles CSI (`ESC [ … final`) and SS3 (`ESC O x`) forms; returns the index of
// the sequence's last byte so the caller's loop increment lands past it.
function skipEscape(data, i) {
  if (data[i + 1] === '[' || data[i + 1] === 'O') {
    let j = i + 2;
    while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++;
    return j;
  }
  return i + 1; // a lone ESC (or unknown intro): just consume the ESC itself
}

// Feed one input chunk through the running buffer. Returns { buf, effort } — the
// updated buffer and the matched level (lowercased) when Enter closed a matching
// line this chunk, else null.
function feedEffortInput(buf, data) {
  let effort = null;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === '\r' || ch === '\n') {
      const m = EFFORT_RE.exec(buf.trim());
      if (m) effort = m[1].toLowerCase();
      buf = '';
    } else if (code === 0x7f || code === 0x08) {
      buf = buf.slice(0, -1); // backspace / delete
    } else if (code === 0x03 || code === 0x15) {
      buf = ''; // Ctrl-C / Ctrl-U kill the line
    } else if (code === 0x1b) {
      i = skipEscape(data, i); // swallow an escape sequence without touching buf
    } else if (code >= 0x20) {
      buf += ch;
      if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
    }
    // other control bytes (< 0x20) are ignored
  }
  return { buf, effort };
}

module.exports = { feedEffortInput };
