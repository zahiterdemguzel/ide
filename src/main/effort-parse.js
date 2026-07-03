// Pure (Electron-free) helper that watches a session's raw PTY input for a
// `/effort <level>` slash command the user typed straight into the chat, so the
// session-bar effort badge can track a change made from the terminal (not just via
// the badge's own dropdown). Kept apart from the IPC glue in sessions.js so it stays
// unit-tested (test/effort-parse.test.js). The line-buffer bookkeeping lives in the
// shared slash-parse.js; this only layers the command match on top.
//
// Only a line that is *exactly* the command matches, so stray prose never triggers
// a false positive. `/effort` with no level (the interactive slider) can't be
// resolved from the input stream, so it's deliberately not detected.

const { feedLine } = require('./slash-parse');

const EFFORT_RE = /^\/effort\s+(auto|low|medium|high|xhigh|max)$/i;

// Feed one input chunk through the running buffer. Returns { buf, effort } — the
// updated buffer and the matched level (lowercased) when Enter closed a matching
// line this chunk, else null.
function feedEffortInput(buf, data) {
  let effort = null;
  buf = feedLine(buf, data, (line) => {
    const m = EFFORT_RE.exec(line.trim());
    if (m) effort = m[1].toLowerCase();
  });
  return { buf, effort };
}

module.exports = { feedEffortInput };
