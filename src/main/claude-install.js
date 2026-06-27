// Electron-free install commands for the Claude Code setup wizard (see
// docs/architecture.md "Claude Code setup gate"). Only the non-translatable shell
// commands and URLs live here; all prose is in the renderer's i18n strings. Pure,
// so it is unit-tested (test/claude-install.test.js).

const NPM_PACKAGE = '@anthropic-ai/claude-code';
const DOCS_URL = 'https://code.claude.com/docs/en/setup';

// Per-platform commands the wizard runs in its embedded terminals.
//   install         — the native installer alone (needs nothing pre-installed:
//                     curl+bash on macOS/Linux, PowerShell's irm on Windows).
//   installTerminal — the installer plus an explicit `exit`, so the install shell
//                     terminates when it finishes; the wizard watches for that exit
//                     to know the install is done and enable Next.
//   auth            — the Sign-in step's command: launch `claude` (its first run
//                     starts the login flow). On Windows the just-installed binary
//                     isn't on the inherited PATH yet, so refresh PATH from the
//                     registry first; on POSIX the freshly-spawned interactive shell
//                     already re-sources the rc the installer updated.
function installGuide(platform = process.platform) {
  const win32 = platform === 'win32';
  const install = win32
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
  const auth = win32
    ? "$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'"
      + "+[Environment]::GetEnvironmentVariable('Path','Machine'); claude"
    : 'claude';
  return {
    platform,
    install,
    installTerminal: `${install}; exit`,
    auth,
    docsUrl: DOCS_URL,
    run: 'claude',
  };
}

module.exports = { installGuide, NPM_PACKAGE, DOCS_URL };
