// Pure (Electron-free) line buffer for watching a session's raw PTY input for a
// slash command the user typed straight into the chat. The model badge tracks a
// change made from the terminal (not just via its own dropdown), so this shared
// engine keeps the buffer bookkeeping in one place and unit-tested
// (test/slash-parse.test.js); session-cmd-parse.js layers its own command regexes on top.
//
// It maintains a per-session line buffer across input chunks: printable bytes
// accumulate, backspace edits the tail, Enter closes the line (invoking `onLine`
// with the completed text and resetting the buffer), and line-kill keys
// (Ctrl-C / Ctrl-U) clear it. Terminal escape sequences (arrow keys, etc.) are
// swallowed so a cursor move mid-line neither matches nor corrupts the buffer.

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

// Feed one input chunk through the running buffer, calling `onLine(text)` for each
// line the user closes with Enter this chunk (text is the raw line, untrimmed).
// Returns the updated buffer.
function feedLine(buf, data, onLine) {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === '\r' || ch === '\n') {
      onLine(buf);
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
  return buf;
}

module.exports = { feedLine };
