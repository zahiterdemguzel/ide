// Electron-free install guidance for the Claude Code CLI, used by the setup gate
// (see .claude/memory/architecture.md "Claude Code setup gate"). Only the non-translatable
// shell commands and URLs live here; all the surrounding prose stays in the
// renderer's i18n strings. Pure, so it is unit-tested (test/claude-install.test.js).

const DOCS_URL = 'https://code.claude.com/docs/en/setup';

// Outcome markers the install command echoes so the wizard can tell whether the
// install actually succeeded — the terminal's shell stays alive (or, on POSIX, the
// markers print just before it exits), so there's no process exit code to read. Two
// outcomes, chosen by the installer's exit status: OK and FAIL. A failed install must
// never be reported as success.
const INSTALL_OK = 'CLAUDE_SETUP_INSTALL_OK';
const INSTALL_FAIL = 'CLAUDE_SETUP_INSTALL_FAIL';

// The native installer; nothing needs to be pre-installed on any platform (Windows
// ships PowerShell's `irm` + .NET, macOS/Linux ship curl + bash). The trailing
// echo prints OK or FAIL based on the installer's exit status.
const POSIX_INSTALL = `curl -fsSL https://claude.ai/install.sh | bash && echo ${INSTALL_OK} || echo ${INSTALL_FAIL}`;
const WIN_INSTALL = `irm https://claude.ai/install.ps1 | iex; if ($?) { echo ${INSTALL_OK} } else { echo ${INSTALL_FAIL} }`;

// Windows can't re-source a profile and a new process won't see the installer's PATH
// edit until a restart, so re-read PATH from the registry into this session before
// launching claude.
const WIN_AUTH = "$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'"
  + "+[Environment]::GetEnvironmentVariable('Path','Machine'); claude";

// We run these commands by spawning the terminal's shell with the command as a shell
// *argument* (`zsh -ilc '<cmd>'`), NOT by typing it into an interactive prompt. Typing
// into a freshly-spawned interactive shell races its line editor — zsh's ZLE on macOS
// in particular swallowed the command, so "the zsh terminal wasn't working". Passing
// the command as an argument runs it directly and reliably.
//
// `-il` = login + interactive, so the shell sources the user's profile/rc and inherits
// their *real* PATH/env. This matters on macOS: a GUI-launched Electron app otherwise
// gets a stripped-down launchd environment, not what the user has in Terminal.app —
// the reason an install could appear to run yet not take. It also puts the
// freshly-installed `claude` on PATH for the sign-in step. Windows PowerShell has no
// login concept and inherits the full env, so `-NoExit -Command` is enough (with the
// registry PATH refresh baked into the auth command).
function installArgs(platform = process.platform) {
  return platform === 'win32'
    ? ['-NoLogo', '-NoExit', '-Command', WIN_INSTALL]
    : ['-ilc', POSIX_INSTALL];
}

function authArgs(platform = process.platform) {
  return platform === 'win32'
    ? ['-NoLogo', '-NoExit', '-Command', WIN_AUTH]
    : ['-ilc', 'claude'];
}

// The whole guide the renderer needs: the argv to spawn for each step, the marker
// strings to watch for, the docs URL, and the bare login command.
function installGuide(platform = process.platform) {
  return {
    platform,
    installArgs: installArgs(platform),
    authArgs: authArgs(platform),
    installOk: INSTALL_OK,
    installFail: INSTALL_FAIL,
    docsUrl: DOCS_URL,
    run: 'claude',
  };
}

module.exports = { installGuide, installArgs, authArgs, INSTALL_OK, INSTALL_FAIL, DOCS_URL };
