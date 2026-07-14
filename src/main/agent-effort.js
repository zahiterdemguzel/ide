// Pure (Electron-free) helper for a session's reasoning-effort level — how hard the
// model thinks before it answers. The `claude` CLI takes it two ways, and a session
// needs both: `--effort <level>` when the process is spawned, and the `/effort <level>`
// slash command while it runs. Kept as plain data so it's unit-tested
// (test/agent-effort.test.js); sessions.js applies it in both places.
//
// `auto` — and anything empty or unrecognized — means "don't pass the flag", leaving
// the CLI to resolve the effort from the model's own default. The list is the CLI's;
// the clients (settings.js on the desktop, models.ts on the phone) own which of these
// they offer.

const AUTO = 'auto';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

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

module.exports = { AUTO, EFFORT_LEVELS, cleanEffort, effortArgs };
