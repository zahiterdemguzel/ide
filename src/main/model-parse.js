// Pure (Electron-free) helper that watches a session's raw PTY input for a
// `/model <name>` slash command the user typed straight into the chat, so the
// session-bar model badge can track a change made from the terminal (not just via
// the badge's own dropdown). Mirrors effort-parse.js — the line-buffer bookkeeping
// lives in the shared slash-parse.js; this only layers the command match on top,
// and it stays unit-tested (test/model-parse.test.js).
//
// The names match the selectable aliases (settings.js MODELS): the `default`
// inherit sentinel plus the product aliases the CLI resolves. Only a line that is
// *exactly* the command matches, so stray prose never triggers a false positive.
// A bare `/model` (the interactive picker) can't be resolved from the input stream,
// so it's deliberately not detected.

const { feedLine } = require('./slash-parse');

const MODEL_RE = /^\/model\s+(default|fable|opus|sonnet|haiku)$/i;

// Feed one input chunk through the running buffer. Returns { buf, model } — the
// updated buffer and the matched model id (lowercased) when Enter closed a matching
// line this chunk, else null.
function feedModelInput(buf, data) {
  let model = null;
  buf = feedLine(buf, data, (line) => {
    const m = MODEL_RE.exec(line.trim());
    if (m) model = m[1].toLowerCase();
  });
  return { buf, model };
}

module.exports = { feedModelInput };
