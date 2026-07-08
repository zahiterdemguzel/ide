const { ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { getRepoPath } = require('./repo');
const { sessions } = require('./sessions');
const { projectDirName, accumulateTranscript, totalTokens } = require('./usage-stats-lib');
const { costUsd } = require('./pricing');

// Settings → Activity: per-model token usage + estimated API-rate cost for the
// open project, read from the Claude Code transcript files on disk (the same
// token classes the per-session statusline sums). One synchronous sweep per
// dialog open — the transcripts live under ~/.claude/projects/<munged cwd>/, one
// dir for the project itself plus one per session worktree (a worktree session's
// cwd is its worktree, so its transcript lands in that dir).
ipcMain.handle('get-usage-stats', async () => {
  try {
    const repo = getRepoPath();
    const base = path.join(os.homedir(), '.claude', 'projects');
    const dirs = new Set([path.join(base, projectDirName(repo))]);
    for (const [, s] of sessions) {
      if (s.workdir && (s.repo === repo || !s.repo)) dirs.add(path.join(base, projectDirName(s.workdir)));
    }
    const acc = new Map();
    const seen = new Set();
    let transcripts = 0;
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; } // no transcripts yet
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        try {
          accumulateTranscript(fs.readFileSync(path.join(dir, n), 'utf8'), acc, seen);
          transcripts++;
        } catch { /* unreadable transcript — skip it */ }
      }
    }
    const models = [...acc]
      .map(([model, tokens]) => ({ model, tokens, totalTokens: totalTokens(tokens), costUsd: costUsd(model, tokens) }))
      .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.totalTokens - a.totalTokens);
    return {
      ok: true,
      transcripts,
      models,
      totalTokens: models.reduce((n, m) => n + m.totalTokens, 0),
      totalCostUsd: models.reduce((n, m) => n + (m.costUsd || 0), 0),
    };
  } catch (err) {
    return { ok: false, error: String(err), models: [], totalTokens: 0, totalCostUsd: 0, transcripts: 0 };
  }
});

module.exports = {};
