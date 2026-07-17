// Pure (Electron-free) model of the agent-CLI providers a session can run: the
// Claude Code CLI (the default), a local Ollama model routed through the Claude
// CLI, and the OpenAI Codex CLI. A session's model id encodes its provider as a
// prefix (`codex:gpt-5.5`, `ollama:llama3`; everything else is Claude), and the
// session is locked to that family for life — see canSwitchModel. sessions.js
// asks this module which binary flavour to spawn and with which argv; keeping
// the argv construction here (plain data) keeps it unit-tested
// (test/agent-providers.test.js).

const { isOllamaId } = require('./ollama-models-lib');
const { codexEffortValue } = require('./agent-effort');

const CODEX_PREFIX = 'codex:';
const isCodexId = (id) => typeof id === 'string' && id.startsWith(CODEX_PREFIX);
const codexModelName = (id) => (isCodexId(id) ? id.slice(CODEX_PREFIX.length) : String(id || ''));

// Which CLI family a model id belongs to. An empty/`default` selection is a
// Claude session inheriting the CLI's own default model.
function modelFamily(id) {
  if (isCodexId(id)) return 'codex';
  if (isOllamaId(id)) return 'ollama';
  return 'claude';
}

// A session's model may only move within its family: a Codex conversation lives
// in ~/.codex and a Claude one in ~/.claude, so switching CLIs mid-session would
// abandon the conversation. Ollama sessions are additionally frozen: their proxy
// routing is baked into the spawned env, and the product decision is that a
// local-model session keeps its model for life.
function canSwitchModel(from, to) {
  const f = modelFamily(from);
  return f === modelFamily(to) && f !== 'ollama';
}

// The hook events Codex fires that our status/tracking pipeline consumes — the
// same seven Claude wires via hooksSettings, plus SubagentStart (Codex announces
// subagent spawns as their own event rather than a Task/Agent tool call).
const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop'];

// The command each Codex hook runs: POST the payload from stdin to our hook
// server, tagging the request with the IDE's own session id (`?ide=`) so the
// server can map Codex's self-generated session_id back to ours (Codex has no
// --session-id; see hook-events.normalizeHookPayload). On Windows, Codex runs
// hook commands through PowerShell, where bare `curl` is an alias for
// Invoke-WebRequest and a bare `@-` is a parser error — so the real binary is
// named explicitly and `@-` is quoted (verified against codex 0.142).
function codexHookCommand(port, ideId, platform) {
  const url = `http://127.0.0.1:${port}/hook?ide=${ideId}`;
  return platform === 'win32'
    ? `curl.exe -s -X POST '${url}' -d '@-'`
    : `curl -s -X POST '${url}' -d @-`;
}

// The `-c hooks.<Event>=…` override pairs that wire every event to the command
// above. Config overrides (not a settings file) so the user's ~/.codex/config.toml
// is never touched — the same never-touch-global rule as Claude's --settings blob.
function codexHookOverrides(port, ideId, platform) {
  const cmd = codexHookCommand(port, ideId, platform);
  return CODEX_HOOK_EVENTS.flatMap((e) => (
    ['-c', `hooks.${e}=[{hooks=[{type="command", command="${cmd}"}]}]`]
  ));
}

// The full argv for spawning a Codex session. A resume without a recorded
// agentSessionId (the session died before its first SessionStart hook) starts a
// fresh conversation instead — the closest Codex offers to Claude's failed
// --resume. `--dangerously-bypass-hook-trust` is required for the hooks injected
// above to run without an interactive trust prompt; they only ever point at our
// own localhost server.
function codexSpawnArgs({ resume, agentSessionId, model, effort, port, ideId, platform }) {
  const args = [];
  if (resume && agentSessionId) args.push('resume', agentSessionId);
  const bare = codexModelName(model);
  if (bare) args.push('--model', bare);
  const e = codexEffortValue(effort);
  if (e) args.push('-c', `model_reasoning_effort="${e}"`);
  args.push(...codexHookOverrides(port, ideId, platform), '--dangerously-bypass-hook-trust');
  return args;
}

module.exports = { modelFamily, canSwitchModel, isCodexId, codexModelName, codexSpawnArgs, codexHookCommand, CODEX_HOOK_EVENTS };
