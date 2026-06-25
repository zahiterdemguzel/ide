const { execFileSync } = require('child_process');

// node-pty on Windows doesn't search PATH — resolve the full claude.exe path once.
let claudeCmd = null;
function resolveClaude() {
  if (claudeCmd) return claudeCmd;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['claude'], { encoding: 'utf8' });
    claudeCmd = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'claude';
  } catch { claudeCmd = 'claude'; }
  return claudeCmd;
}

module.exports = { resolveClaude };
