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
// Unlike the model, an effort is never picked up front or remembered for the next
// session: a session is created at its family's default and the level is switched on the
// running session. `auto` is a real choice (reset to the model's own default), not a
// "nothing selected" sentinel — hence a row of its own.
export const EFFORTS = [
  { id: 'auto', name: 'Auto', hint: "The model's own default" },
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
  { id: 'auto', name: 'Auto', hint: "The model's own default" },
  { id: 'low', name: 'Low', hint: 'Quick answers' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
];

export const DEFAULT_EFFORT = 'auto';

export function effortsForFamily(family) {
  return family === 'codex' ? CODEX_EFFORTS : EFFORTS;
}

// A session's effort as its badge says it. An empty record means the level was never
// set, which is exactly what `auto` names; a level this build doesn't know about still
// shows what the session is running rather than lying about it.
export function effortNameForFamily(id, family) {
  const level = id || DEFAULT_EFFORT;
  return effortsForFamily(family).find((e) => e.id === level)?.name ?? level;
}
