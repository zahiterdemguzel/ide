// Electron-free install guidance for the Claude Code CLI, used by the setup gate
// (see docs/architecture.md "Claude Code setup gate"). Only the non-translatable
// shell commands and URLs live here; all the surrounding prose stays in the
// renderer's i18n strings. Pure, so it is unit-tested (test/claude-install.test.js).

const NPM_PACKAGE = '@anthropic-ai/claude-code';
const DOCS_URL = 'https://code.claude.com/docs/en/setup';

// Chain `claude` onto an install command so the login flow starts automatically
// once the install succeeds — what the in-dialog terminal runs. The catch is PATH:
// the just-installed binary lives in a dir the *current* shell didn't have on PATH
// when it started, so a bare `claude` would be "command not found".
//   - POSIX: re-exec a login+interactive shell (`exec "$SHELL" -ilc claude`) so the
//     rc/profile the installer edited is re-sourced and the new PATH is live.
//   - Windows: re-read PATH from the registry into the current PowerShell session
//     (the installer wrote it there) before launching claude.
function withAuth(platform, installCmd) {
  if (platform === 'win32') {
    return `${installCmd}; $env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'`
      + `+[Environment]::GetEnvironmentVariable('Path','Machine'); claude`;
  }
  return `${installCmd} && exec "$SHELL" -ilc claude`;
}

// The native installer needs nothing pre-installed on macOS (curl + bash ship by
// default) or Windows (PowerShell's `irm` + .NET ship by default), so those get a
// single option and `npm` is null. Linux keeps the npm fallback: bash is always
// present but `curl` isn't guaranteed on a minimal install, so the native command
// can fail there.
//
// Each option carries `command` (the plain install line — what the Copy button
// yields) and `terminalCommand` (install + auto-launch `claude` for auth — what the
// in-dialog "Run in terminal" runs). `run` is the bare login command.
function installGuide(platform = process.platform) {
  const nativeCmd = platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    // darwin, linux, WSL, and anything else POSIX-shaped
    : 'curl -fsSL https://claude.ai/install.sh | bash';
  const native = {
    id: platform === 'win32' ? 'powershell' : 'shell',
    command: nativeCmd,
    terminalCommand: withAuth(platform, nativeCmd),
  };
  const npmCmd = `npm install -g ${NPM_PACKAGE}`;
  const npm = (platform === 'darwin' || platform === 'win32')
    ? null
    : { id: 'npm', command: npmCmd, terminalCommand: withAuth(platform, npmCmd) };
  return { platform, native, npm, docsUrl: DOCS_URL, run: 'claude' };
}

module.exports = { installGuide, withAuth, NPM_PACKAGE, DOCS_URL };
