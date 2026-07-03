// Pure (Electron-free) helper that turns a session's model + effort selection into
// the environment variables the `claude` CLI reads to pick which model runs the
// main agent and its subagents (Explore/Plan/general-purpose/Task) and how hard it
// reasons. Kept here as plain data so it's unit-tested (test/agent-models.test.js);
// sessions.js merges the result into the spawned PTY's env.
//
//   ANTHROPIC_MODEL            — the main session's model.
//   CLAUDE_CODE_SUBAGENT_MODEL — the model used for every subagent.
//   CLAUDE_CODE_EFFORT_LEVEL   — the reasoning-effort level (low/medium/high/xhigh/max).
//
// The renderer owns the list of *selectable* values (the dropdowns/picker, see
// settings.js), so this stays permissive: any non-empty selection other than the
// `default`/`auto` sentinels is passed through verbatim (a model alias like `opus`
// or an effort like `high` both work). `default`/`auto`/empty means "don't set the
// var" — the CLI then resolves the model / its own default effort normally.

const DEFAULT = 'default';
const AUTO = 'auto';

function clean(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return !s || s === DEFAULT || s === AUTO ? '' : s;
}

function modelEnv(selection = {}) {
  const env = {};
  const model = clean(selection.model);
  const subagentModel = clean(selection.subagentModel);
  const effort = clean(selection.effort);
  if (model) env.ANTHROPIC_MODEL = model;
  if (subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  return env;
}

module.exports = { DEFAULT, AUTO, modelEnv };
