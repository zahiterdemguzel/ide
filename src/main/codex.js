// The OpenAI Codex CLI counterparts of claude.js's resolve/detect helpers.
// Deliberately minimal: Haiku generation, usage meters and OAuth reading stay
// Claude-only — Codex has no statusLine or rate-limit-header equivalent, so a
// Codex session simply doesn't feed those features.

const { execFile } = require('child_process');

// node-pty on Windows doesn't search PATH — resolve the full codex path once,
// asynchronously (same reasoning as resolveClaude). Unlike claude (a native
// .exe), an npm-installed codex puts an extension-less sh shim FIRST on `where`'s
// output, which CreateProcess (and so node-pty) can't run — prefer the
// .cmd/.exe sibling.
let codexCmd = null;
function resolveCodex() {
  if (codexCmd) return codexCmd;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  codexCmd = new Promise((resolve) => {
    execFile(finder, ['codex'], { encoding: 'utf8' }, (err, stdout) => {
      const lines = err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const runnable = process.platform === 'win32'
        ? lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0]
        : lines[0];
      resolve(runnable || 'codex');
    });
  });
  return codexCmd;
}

// Is the Codex CLI installed and runnable? Same probe shape as claudeAvailable,
// but this one gates only the *optional* Codex setup dialog: picking a codex:
// model with no CLI offers to install it, never blocks the app.
async function codexAvailable() {
  codexCmd = null; // re-probe PATH: the user may have just installed it
  const exe = await resolveCodex();
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    execFile(win32 ? `"${exe}"` : exe, ['--version'],
      { timeout: 10000, shell: win32 },
      (err, stdout) => {
        if (err) return resolve({ installed: false, version: null });
        resolve({ installed: true, version: (stdout || '').trim() || null });
      });
  });
}

// Whether the CLI holds working credentials: `codex login status` exits 0 when
// logged in (any auth mode), non-zero otherwise. Unknowable when not installed.
async function codexLoggedIn() {
  const exe = await resolveCodex();
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    execFile(win32 ? `"${exe}"` : exe, ['login', 'status'],
      { timeout: 10000, shell: win32 },
      (err) => resolve(!err));
  });
}

module.exports = { resolveCodex, codexAvailable, codexLoggedIn };
