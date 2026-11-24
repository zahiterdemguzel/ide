const { ipcRenderer } = require('electron');

// The open project's custom agents (.claude/agents, .codex/agents) for Settings → Agents.
module.exports = {
  listAgents: () => ipcRenderer.invoke('agents-list'),
  saveAgent: (agent) => ipcRenderer.invoke('agents-save', agent),
  deleteAgent: (args) => ipcRenderer.invoke('agents-delete', args),
};
