// Electron-free install guidance for the Claude Code CLI, used by the setup gate
// (see docs/architecture.md "Claude Code setup gate"). Only the non-translatable
// shell commands and URLs live here; all the surrounding prose stays in the
// renderer's i18n strings. Pure, so it is unit-tested (test/claude-install.test.js).

const DOCS_URL = 'https://code.claude.com/docs/en/setup';

// The wizard's "installing" step runs the install command in an embedded terminal
// and needs to know when it has finished (the shell stays alive afterward, so there
// is no process-exit to watch). We append an `echo` of this marker so its arrival in
// the terminal output flips the Next button on.
//
// The shell *echoes the command line itself* before running it, and that echo would
// also contain the marker — enabling Next instantly. To avoid that, the printed form
// embeds a quote (INSTALL_DONE_ECHO): the echoed command keeps the quote, but the
// program's actual output collapses it away, so only real completion matches
// INSTALL_DONE. The trick works identically in POSIX shells and PowerShell
// (`a"b"` → `ab` in both).
const INSTALL_DONE = 'CLAUDE_SETUP_INSTALL_COMPLETE';
const INSTALL_DONE_ECHO = 'CLAUDE_SETUP_INSTALL_"COMPLETE"';

// The native installer needs nothing pre-installed on any platform: Windows ships
// PowerShell's `irm` + .NET, macOS/Linux ship curl + bash. We chain the completion
// marker with `;` (not `&&`) so it prints whether the install succeeds or fails —
// the wizard treats "command finished" as "you may proceed", and a genuine failure
// surfaces later when `claude` can't be found / the final probe comes up empty.
function installCommand(platform = process.platform) {
  const base = platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    // darwin, linux, WSL, and anything else POSIX-shaped
    : 'curl -fsSL https://claude.ai/install.sh | bash';
  return `${base}; echo ${INSTALL_DONE_ECHO}`;
}

// Start the login flow by running `claude` — what the wizard's "sign in" step runs in
// its terminal. The catch is PATH: the just-installed binary lives in a dir the
// *current* shell didn't have on PATH when it started, so a bare `claude` would be
// "command not found".
//   - POSIX: re-exec a login+interactive shell (`exec "$SHELL" -ilc claude`) so the
//     rc/profile the installer edited is re-sourced and the new PATH is live.
//   - Windows: re-read PATH from the registry into the current PowerShell session
//     (the installer wrote it there) before launching claude.
function authCommand(platform = process.platform) {
  if (platform === 'win32') {
    return "$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'"
      + "+[Environment]::GetEnvironmentVariable('Path','Machine'); claude";
  }
  return 'exec "$SHELL" -ilc claude';
}

// The whole guide the renderer needs: the install command (with its completion
// marker), the auth command, the marker string to watch for, the docs URL, and the
// bare login command.
function installGuide(platform = process.platform) {
  return {
    platform,
    install: installCommand(platform),
    auth: authCommand(platform),
    installDone: INSTALL_DONE,
    docsUrl: DOCS_URL,
    run: 'claude',
  };
}

module.exports = { installGuide, installCommand, authCommand, INSTALL_DONE, DOCS_URL };
