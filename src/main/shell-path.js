// The user's real PATH, for an app launched from the Dock or Finder.
//
// A GUI-launched macOS app inherits launchd's minimal PATH (/usr/bin:/bin:…), not
// the one the user's shell builds — so `claude` in ~/.local/bin, Homebrew tools
// and nvm's node are all invisible to it. That made the Claude Code setup gate
// decide the CLI wasn't installed and walk a signed-in user through install and
// sign-in. The login shell's PATH is read once and merged into process.env.PATH,
// so the CLI lookup, session PTYs and consoles all see what Terminal.app sees.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { cleanEnv } = require('./proc-env');
const { searchDirs, extraSearchDirs, loginShellPathCommand, parseLoginShellPath } = require('./lsp-lib');

// Resolves to the login shell's PATH, or null on Windows / when the shell can't run.
let loginShellPathPromise = null;
function loginShellPath() {
  if (process.platform === 'win32') return Promise.resolve(null);
  if (!loginShellPathPromise) {
    loginShellPathPromise = new Promise((resolve) => {
      const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
      execFile(shell, ['-ilc', loginShellPathCommand()], { env: cleanEnv(), timeout: 5000, encoding: 'utf8' },
        (_err, stdout) => resolve(parseLoginShellPath(stdout)));
    });
  }
  return loginShellPathPromise;
}

// Merge the login shell's PATH (and the usual install dirs, as a backstop for a
// shell that couldn't be read) after the inherited one. Idempotent; never rejects.
let adopted = null;
function adoptLoginShellPath() {
  if (process.platform === 'win32') return Promise.resolve();
  if (!adopted) {
    adopted = loginShellPath().then((shellPath) => {
      const merged = searchDirs({
        envPath: process.env.PATH,
        loginShellPath: shellPath,
        extra: extraSearchDirs({ home: os.homedir(), platform: process.platform, env: process.env })
          .filter((dir) => fs.existsSync(dir)),
        platform: process.platform,
      });
      process.env.PATH = merged.join(':');
    }).catch(() => {});
  }
  return adopted;
}

module.exports = { loginShellPath, adoptLoginShellPath };
