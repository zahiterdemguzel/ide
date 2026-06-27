// Electron-free install guidance for the Claude Code CLI, used by the first-run
// setup gate (see docs/architecture.md "Claude Code setup gate"). Only the
// non-translatable shell commands and URLs live here; all the surrounding prose
// stays in the renderer's i18n strings. Pure, so it is unit-tested
// (test/claude-install.test.js).

const NPM_PACKAGE = '@anthropic-ai/claude-code';
const DOCS_URL = 'https://code.claude.com/docs/en/setup';

// The recommended native installer for the given platform plus the npm fallback
// that works everywhere (Node 18+). `run` is the command that starts Claude Code
// after install (its first run prompts the user to log in). The renderer renders
// each `command` verbatim with a copy button and an "install in terminal" action.
function installGuide(platform = process.platform) {
  const native = platform === 'win32'
    ? { id: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex' }
    // darwin, linux, WSL, and anything else POSIX-shaped
    : { id: 'shell', command: 'curl -fsSL https://claude.ai/install.sh | bash' };
  return {
    platform,
    native,
    npm: { id: 'npm', command: `npm install -g ${NPM_PACKAGE}` },
    docsUrl: DOCS_URL,
    run: 'claude',
  };
}

module.exports = { installGuide, NPM_PACKAGE, DOCS_URL };
