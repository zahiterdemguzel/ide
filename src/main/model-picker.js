// Pure (Electron-free) helper: the keystrokes that drive Claude Code's Alt+P model
// picker, so a model or effort switch lands *instantly* — a `/model` or `/effort`
// typed into the composer sits in the input queue until the current turn ends, which
// is exactly when you no longer need it. The picker is an overlay the TUI handles
// even while the agent is streaming.
//
// Established against a live CLI (2.1.211), not guessed:
//   - `\x1bp` (Alt+P) opens the picker, mid-turn included.
//   - up/down move the model row; the list WRAPS at both ends.
//   - left/right move the effort slider; it wraps too.
//   - `s` applies the highlighted model *for this session only*. Enter would save it
//     as the global default, and a bare number key selects AND saves — never send those.
//   - an effort change persists to ~/.claude/settings.json (`effortLevel`) on apply,
//     exactly as a typed `/effort` does — so reading that file back is how a session
//     whose record carries no effort learns where the slider currently sits.
//
// Everything here is relative movement from a known position, so a plan exists only
// when both ends are known. An id or level this table can't place returns null and
// sessions.js falls back to typing the slash command — a CLI relayout degrades to
// today's queued behaviour, never to keys landing on the wrong row.

const PICKER_OPEN = '\x1bp';
const PICKER_APPLY = 's';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

// The picker's rows and slider stops, in the CLI's own order. `ultracode` is a real
// slider stop even though no client of ours offers it — a user can put the slider
// there from the terminal, and a plan computed against a five-stop list would then
// land every later switch one stop off.
const MODEL_ROWS = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
const EFFORT_STOPS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

// Where an id sits in the picker's list, or -1. The clients send bare aliases
// (`opus`, `fable`, …), but a record can also carry a full model id (`claude-opus-4-8`,
// typed via /model), so the family name is matched anywhere in the id. Ollama ids
// (`ollama:…`) never match: that switch is a respawn, not a picker move.
function modelRow(id) {
  const s = typeof id === 'string' ? id.trim().toLowerCase() : '';
  if (!s || s.startsWith('ollama:')) return -1;
  if (s === 'default') return 0;
  const i = MODEL_ROWS.findIndex((name) => name !== 'default' && s.includes(name));
  return i;
}

function effortStop(level) {
  const s = typeof level === 'string' ? level.trim().toLowerCase() : '';
  return EFFORT_STOPS.indexOf(s);
}

// Shortest signed distance around a wrapping list of `len` entries.
function wrapDelta(from, to, len) {
  let d = (to - from) % len;
  if (d > len / 2) d -= len;
  if (d < -len / 2) d += len;
  return d;
}

// The arrow presses that take the picker from one known position to another, as one
// string (the TUI ingests a batch of arrows fine), or null when either end is unknown.
function modelMoves(currentId, targetId) {
  const from = modelRow(currentId);
  const to = modelRow(targetId);
  if (from < 0 || to < 0) return null;
  const d = wrapDelta(from, to, MODEL_ROWS.length);
  return (d >= 0 ? DOWN : UP).repeat(Math.abs(d));
}

function effortMoves(currentLevel, targetLevel) {
  const from = effortStop(currentLevel);
  const to = effortStop(targetLevel);
  if (from < 0 || to < 0) return null;
  const d = wrapDelta(from, to, EFFORT_STOPS.length);
  return (d >= 0 ? RIGHT : LEFT).repeat(Math.abs(d));
}

module.exports = {
  PICKER_OPEN, PICKER_APPLY, MODEL_ROWS, EFFORT_STOPS,
  modelRow, effortStop, modelMoves, effortMoves,
};
