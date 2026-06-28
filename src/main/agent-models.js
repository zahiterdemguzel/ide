// Pure (Electron-free) helper that turns a session's model selection into the
// environment variables the `claude` CLI reads to pick which model runs the main
// agent and its subagents (Explore/Plan/general-purpose/Task). Kept here as plain
// data so it's unit-tested (test/agent-models.test.js); sessions.js merges the
// result into the spawned PTY's env.
//
//   ANTHROPIC_MODEL            — the main session's model.
//   CLAUDE_CODE_SUBAGENT_MODEL — the model used for every subagent.
//
// The renderer owns the list of *selectable* models (the dropdowns, see
// settings.js), so this stays permissive: any non-empty selection other than the
// `default` sentinel is passed through verbatim (a model alias like `opus` or a
// full model id both work). `default` / empty means "don't set the var" — the CLI
// then resolves the model normally (subagents inherit the main model).

const DEFAULT = 'default';

function clean(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return !s || s === DEFAULT ? '' : s;
}

function modelEnv(selection = {}) {
  const env = {};
  const model = clean(selection.model);
  const subagentModel = clean(selection.subagentModel);
  if (model) env.ANTHROPIC_MODEL = model;
  if (subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  return env;
}

module.exports = { DEFAULT, modelEnv };
