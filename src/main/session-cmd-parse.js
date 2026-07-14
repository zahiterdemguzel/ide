// Pure (Electron-free) helper that watches a session's raw PTY input for a
// `/model <name>` or `/effort <level>` slash command the user typed straight into the
// chat, so the session-bar badges can track a change made from the terminal (not just
// via their own menus). The line-buffer bookkeeping lives in the shared slash-parse.js;
// this only layers the command matches on top, and it stays unit-tested
// (test/session-cmd-parse.test.js).
//
// Both commands are read off ONE buffer because the user is typing one line: a second
// parser fed the same keystrokes would have to repeat the same backspace/escape/kill
// bookkeeping to stay in step with it.
//
// The names match the selectable values (settings.js MODELS, agent-effort.js
// EFFORT_LEVELS). Only a line that is *exactly* the command matches, so stray prose
// never triggers a false positive. A bare `/model` / `/effort` (the interactive picker
// each opens) can't be resolved from the input stream, so it's deliberately not
// detected.

const { feedLine } = require('./slash-parse');

const MODEL_RE = /^\/model\s+(default|fable|opus|sonnet|haiku)$/i;
const EFFORT_RE = /^\/effort\s+(auto|low|medium|high|xhigh|max)$/i;

// Feed one input chunk through the running buffer. Returns { buf, model, effort } — the
// updated buffer, plus the matched value when Enter closed a matching line this chunk
// (null for whichever command wasn't typed).
function feedSessionCommand(buf, data) {
  let model = null;
  let effort = null;
  buf = feedLine(buf, data, (line) => {
    const l = line.trim();
    const m = MODEL_RE.exec(l);
    if (m) model = m[1].toLowerCase();
    const e = EFFORT_RE.exec(l);
    if (e) effort = e[1].toLowerCase();
  });
  return { buf, model, effort };
}

module.exports = { feedSessionCommand };
