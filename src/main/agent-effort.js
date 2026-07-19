// Pure (Electron-free) helper for a session's reasoning-effort level — how hard the
// model thinks before it answers. The `claude` CLI takes it two ways, and a session
// needs both: `--effort <level>` when the process is spawned, and the `/effort <level>`
// slash command while it runs. Kept as plain data so it's unit-tested
// (test/agent-effort.test.js); sessions.js applies it in both places.
//
// Every session runs at a level it can name. There is deliberately no `auto` and no
// "unset": a session whose effort the badge can't state is one reasoning at some level
// the user never chose and can't see, which is the surprise this module exists to
// prevent. Anything empty or unrecognized is therefore resolved to a real level
// (defaultEffortFor) rather than passed through as "let the CLI decide". The list is
// the CLI's; the clients (settings.js on the desktop, models.ts on the phone) own which
// of these they offer.

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The Codex CLI's own ladder (`model_reasoning_effort`): no `max`. Which ladder applies
// is the session's model family — see effortLevelsFor; the clients read this to build
// their per-family menus.
//
// `minimal` is Codex's own lowest stop and is deliberately **not** here: the API refuses
// it outright when the request also carries the `web_search` tool, which Codex sends —
// `400 invalid_request_error: The following tools cannot be used with reasoning.effort
// 'minimal': web_search`. That kills the turn, not just the thinking, so a session set to
// minimal can't answer at all. Offering a stop we can't make work is worse than not
// offering it; the alternative — quietly switching web_search off to make it legal — trades
// a tool the user wants for a level they rarely need. A record left on `minimal` by an
// older build self-heals: defaultEffortFor doesn't recognize it and resolves it to a
// level the ladder does have.
const CODEX_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];
// The fallback when nothing better is known — a fresh install with no remembered level,
// or a record carrying one this build can't place. Balanced, and the one level both
// ladders share.
const DEFAULT_EFFORT = 'medium';

function effortLevelsFor(family) {
  return family === 'codex' ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS;
}

// The level to actually apply, or '' for "leave it to the CLI". Unknown values are
// dropped rather than passed through — the opposite of a model alias (agent-models.js
// forwards those verbatim, since the CLI resolves them). An unrecognized `--effort`
// value is a hard CLI error, so passing one through would leave the session unable to
// spawn at all, and a session that won't start is a worse outcome than one running at
// the default effort.
function cleanEffort(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return EFFORT_LEVELS.includes(s) ? s : '';
}

// The spawn flags for a session's effort: `--effort high`, or nothing at all.
function effortArgs(effort) {
  const e = cleanEffort(effort);
  return e ? ['--effort', e] : [];
}

// The Codex counterpart of cleanEffort, against Codex's own ladder. Same
// drop-unknown rule: an unrecognized `model_reasoning_effort` would fail the
// spawn outright. '' means "no override" (the model's default). Consumed by
// agent-providers.codexSpawnArgs as a `-c` config override rather than a flag.
function codexEffortValue(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return CODEX_EFFORT_LEVELS.includes(s) ? s : '';
}

// The level a session actually runs at, given what was remembered (the last level the
// user picked, carried over from the client) and the family it belongs to. This is the
// one place "no level" becomes a level: a remembered `max` doesn't survive into a Codex
// session (not on its ladder), and an empty or stale record lands on DEFAULT_EFFORT
// rather than on whatever the CLI would have chosen unseen.
function defaultEffortFor(family, remembered) {
  const s = typeof remembered === 'string' ? remembered.trim().toLowerCase() : '';
  return effortLevelsFor(family).includes(s) ? s : DEFAULT_EFFORT;
}

module.exports = { EFFORT_LEVELS, CODEX_EFFORT_LEVELS, DEFAULT_EFFORT, defaultEffortFor, effortLevelsFor, cleanEffort, effortArgs, codexEffortValue };
