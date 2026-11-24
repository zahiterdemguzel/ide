const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { getMainRepoPath } = require('./repo');
const { writeFileAtomic } = require('./atomic-write');
const { PROVIDERS, slugify, isSafeAgentId, parseAgent, serializeAgent, agentProblem } = require('./agents-lib');

// Custom agents of the open project, read from and written to the project's own
// folders (.claude/agents/*.md, .codex/agents/*.toml), so they are per repository
// and travel with it in git. The project root (not the active worktree) is used so
// every worktree session of a project edits one list. Parsing/serializing is the
// pure agents-lib.js; this module is only file IO + IPC.

function agentsDir(provider) {
  const root = getMainRepoPath();
  if (!root || !PROVIDERS[provider]) return null;
  return path.join(root, PROVIDERS[provider].dir);
}

const agentFile = (provider, id) => path.join(agentsDir(provider), id + PROVIDERS[provider].ext);

function listAgents(provider) {
  const dir = agentsDir(provider);
  if (!dir) return [];
  const { ext } = PROVIDERS[provider];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((fileName) => fileName.endsWith(ext) && isSafeAgentId(fileName.slice(0, -ext.length)))
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => {
      const id = fileName.slice(0, -ext.length);
      try { return parseAgent(provider, fs.readFileSync(path.join(dir, fileName), 'utf8'), id); }
      catch { return null; }
    })
    .filter(Boolean);
}

// First free file stem for a new agent: code-reviewer, code-reviewer-2, …
function freshId(provider, name) {
  const stem = slugify(name) || 'agent';
  let candidate = stem;
  for (let n = 2; fs.existsSync(agentFile(provider, candidate)); n += 1) candidate = `${stem}-${n}`;
  return candidate;
}

// `id` present = editing that file in place; absent = a new agent gets its own file.
function saveAgent(agent) {
  const problem = agentProblem(agent);
  if (problem) return { error: problem };
  const root = getMainRepoPath();
  if (!root) return { error: 'agents.error.noProject' };
  if (agent.id && !isSafeAgentId(agent.id)) return { error: 'agents.error.provider' };
  try {
    fs.mkdirSync(agentsDir(agent.provider), { recursive: true });
    const id = agent.id || freshId(agent.provider, agent.name);
    writeFileAtomic(agentFile(agent.provider, id), serializeAgent(agent));
    return { agent: { ...agent, id } };
  } catch (e) {
    return { error: 'agents.error.write', detail: e.message };
  }
}

function deleteAgent({ provider, id }) {
  if (!getMainRepoPath() || !PROVIDERS[provider] || !isSafeAgentId(id)) return { error: 'agents.error.provider' };
  try {
    fs.rmSync(agentFile(provider, id), { force: true });
    return { ok: true };
  } catch (e) {
    return { error: 'agents.error.write', detail: e.message };
  }
}

ipcMain.handle('agents-list', () => ({
  project: getMainRepoPath(),
  claude: listAgents('claude'),
  codex: listAgents('codex'),
}));
ipcMain.handle('agents-save', (_e, agent) => saveAgent(agent || {}));
ipcMain.handle('agents-delete', (_e, args) => deleteAgent(args || {}));
