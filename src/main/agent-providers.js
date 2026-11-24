// Pure (Electron-free) model of the agent-CLI providers a session can run: the
// Claude Code CLI (the default), a local Ollama model routed through the Claude
// CLI, and the OpenAI Codex CLI. A session's model id encodes its provider as a
// prefix (`codex:gpt-6.1-sol`, `ollama:llama3`; everything else is Claude), and the
// session is locked to that family for life — see canSwitchModel. sessions.js
// asks this module which binary flavour to spawn and with which argv; keeping
// the argv construction here (plain data) keeps it unit-tested
// (test/agent-providers.test.js).

const { isOllamaId } = require('./ollama-models-lib');
const { codexEffortValue } = require('./agent-effort');
const { isEvrenId, isChatgptId, codexProxyOverride } = require('./provider-accounts-lib');

const CODEX_PREFIX = 'codex:';
const isCodexId = (id) => typeof id === 'string' && id.startsWith(CODEX_PREFIX);
const codexModelName = (id) => (isCodexId(id) ? id.slice(CODEX_PREFIX.length) : String(id || ''));

// Keep each named GPT family on its newest known version. At launch the Codex
// catalog can advance these fallbacks without requiring an IDE release.
const LATEST_CODEX_MODELS = {
  sol: 'gpt-6.2-sol', astra: 'gpt-6.2-astra', terra: 'gpt-6.1-terra', luna: 'gpt-6-luna',
};
const RETIRED_CODEX_MODELS = {
  'gpt-5.5': 'sol', 'gpt-5.4': 'sol', 'gpt-5.4-mini': 'luna',
  'gpt-5.3-codex': 'sol', 'gpt-5.3-codex-spark': 'luna', 'gpt-5.2': 'sol',
};
function versionedModel(name) {
  const match = /^gpt-(\d+(?:\.\d+)*)-(sol|astra|terra|luna)$/.exec(name);
  return match && { version: match[1].split('.').map(Number), family: match[2] };
}
function newerModel(a, b) {
  const av = versionedModel(a).version, bv = versionedModel(b).version;
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (av[i] || 0) > (bv[i] || 0);
  }
  return false;
}
function currentModelId(id, models = []) {
  if (!isCodexId(id)) return id;
  const name = codexModelName(id);
  const family = Object.hasOwn(LATEST_CODEX_MODELS, name) ? name : RETIRED_CODEX_MODELS[name] || versionedModel(name)?.family;
  if (!family) return id;
  let latest = LATEST_CODEX_MODELS[family];
  if (versionedModel(name) && newerModel(name, latest)) latest = name;
  for (const model of models) {
    const slug = model?.slug;
    if (model.visibility !== 'hide' && versionedModel(slug)?.family === family && newerModel(slug, latest)) latest = slug;
  }
  return CODEX_PREFIX + latest;
}
function resolveCurrentModelId(id) {
  if (!isCodexId(id)) return id;
  try {
    const path = require('path');
    const home = process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
    const catalog = JSON.parse(require('fs').readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    return currentModelId(id, Array.isArray(catalog.models) ? catalog.models : []);
  } catch {
    return currentModelId(id);
  }
}

// Which CLI family a model id belongs to. An empty/`default` selection is a
// Claude session inheriting the CLI's own default model.
function modelFamily(id) {
  if (isCodexId(id)) return 'codex';
  if (isOllamaId(id)) return 'ollama';
  if (isEvrenId(id)) return 'evren';
  if (isChatgptId(id)) return 'chatgpt';
  return 'claude';
}

// A session's model may only move within its family: a Codex conversation lives
// in ~/.codex and a Claude one in ~/.claude, so switching CLIs mid-session would
// abandon the conversation. Ollama and Evren sessions are additionally frozen: their proxy
// routing is baked into the spawned env, and the product decision is that a
// local-model session keeps its model for life.
function canSwitchModel(from, to) {
  const f = modelFamily(from);
  return f === modelFamily(to) && f !== 'ollama' && f !== 'evren' && f !== 'chatgpt';
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
function codexSpawnArgs({ resume, agentSessionId, model, effort, port, ideId, platform, proxyPort }) {
  const args = [];
  if (resume && agentSessionId) args.push('resume', agentSessionId);
  // Through the account proxy, the active Codex account's login goes out with every request.
  if (proxyPort) args.push(...codexProxyOverride(proxyPort));
  const bare = codexModelName(resolveCurrentModelId(model));
  if (bare) args.push('--model', bare);
  const e = codexEffortValue(effort);
  if (e) args.push('-c', `model_reasoning_effort="${e}"`);
  // Keep the IDE's live effort controls mapped to reasoning actions in this PTY.
  args.push('-c', 'tui.keymap.chat.decrease_reasoning_effort=["alt-,"]',
    '-c', 'tui.keymap.chat.increase_reasoning_effort=["alt-."]');
  args.push('--dangerously-bypass-approvals-and-sandbox',
    ...codexHookOverrides(port, ideId, platform), '--dangerously-bypass-hook-trust');
  return args;
}

module.exports = { modelFamily, canSwitchModel, isCodexId, codexModelName, currentModelId, resolveCurrentModelId, codexSpawnArgs, codexHookCommand, CODEX_HOOK_EVENTS };
