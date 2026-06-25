const { execFile, execFileSync } = require('child_process');

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

// One-shot non-interactive Haiku call (`claude -p --model haiku`). The prompt
// goes over stdin to avoid arg-escaping. Reuses the resolved claude CLI, so no
// API key or new dependency. Resolves to the trimmed stdout, or null on error.
function runHaiku(prompt, { cwd } = {}) {
  return new Promise((resolve) => {
    const exe = resolveClaude();
    const win32 = process.platform === 'win32';
    const child = execFile(win32 ? `"${exe}"` : exe, ['-p', '--model', 'haiku'],
      { cwd, maxBuffer: 1024 * 1024, shell: win32 },
      (err, stdout) => resolve(err ? null : stdout.trim()));
    child.stdin.end(prompt);
  });
}

module.exports = { resolveClaude, runHaiku };
