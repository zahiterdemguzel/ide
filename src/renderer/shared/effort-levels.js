// The reasoning-effort ladders the session-bar badge offers — how hard the model thinks
// before it answers. Pure (DOM-free) so it stays unit-tested (test/effort-levels.test.mjs),
// which is what keeps it honest: main owns the levels that actually work (EFFORT_LEVELS /
// CODEX_EFFORT_LEVELS in src/main/agent-effort.js) and drops any it doesn't recognize, so
// a level offered here but unknown there would be a menu row that silently does nothing.
// The test asserts the two stay in step.
//
// Keyed by CLI family rather than by model id: the family rule lives in settings.js
// (modelFamily), and duplicating it here would be a second place to fix when a family
// is added. Labels stay untranslated, matching the model menu next door.
//
// Like the model, the level picked here is remembered and becomes the default for the
// next session (setSessionEffort in settings.js). There is no `auto` row: every session
// runs at a level the badge can name, so "the model's own default" — a level the user
// never chose and the badge can't show — isn't offerable.
export const EFFORTS = [
  { id: 'low', name: 'Low', hint: 'Fastest, barely thinks' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
  { id: 'max', name: 'Max', hint: 'Deepest thinking, slowest' },
];

// Codex reasons on its own ladder — no `max`, and no `minimal` either: the API rejects
// that level outright alongside Codex's web_search tool, so it's a row that can only
// break the session (see CODEX_EFFORT_LEVELS in src/main/agent-effort.js).
export const CODEX_EFFORTS = [
  { id: 'low', name: 'Low', hint: 'Quick answers' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
];

// Mirror of DEFAULT_EFFORT in src/main/agent-effort.js — the fallback when nothing is
// remembered yet. Main resolves the real level at creation; this only decides what an
// empty picker shows before that.
export const DEFAULT_EFFORT = 'medium';

export function effortsForFamily(family) {
  return family === 'codex' ? CODEX_EFFORTS : EFFORTS;
}

// A session's effort as its badge says it. A level this build doesn't know about still
// shows what the session is running rather than lying about it — records are normalized
// to a real level on load (session-persist.js), so an empty id here means the record
// predates that and its true level is genuinely unknown.
export function effortNameForFamily(id, family) {
  const level = id || DEFAULT_EFFORT;
  return effortsForFamily(family).find((e) => e.id === level)?.name ?? level;
}
