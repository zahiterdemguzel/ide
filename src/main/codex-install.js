// Electron-free install guidance for the OpenAI Codex CLI — the Codex twin of
// claude-install.js, consumed by the *optional* Codex setup dialog (see
// src/renderer/codex-setup.js). Same marker/argv contract as the Claude guide so
// the renderer wizard machinery is reused verbatim. Pure, unit-tested
// (test/codex-install.test.js).

const DOCS_URL = 'https://developers.openai.com/codex/cli';

const INSTALL_OK = 'CODEX_SETUP_INSTALL_OK';
const INSTALL_FAIL = 'CODEX_SETUP_INSTALL_FAIL';

// Codex has no shell-script installer; npm is its documented install path and is
// present on every machine that can run this app's sessions anyway.
const POSIX_INSTALL = `npm install -g @openai/codex && echo ${INSTALL_OK} || echo ${INSTALL_FAIL}`;
const WIN_INSTALL = `npm install -g @openai/codex; if ($?) { echo ${INSTALL_OK} } else { echo ${INSTALL_FAIL} }`;

// Same Windows PATH story as claude-install: a fresh global npm install edits the
// user PATH, which this already-running shell doesn't see — re-read it from the
// registry before launching the sign-in.
const WIN_AUTH = "$env:Path=[Environment]::GetEnvironmentVariable('Path','User')+';'"
  + "+[Environment]::GetEnvironmentVariable('Path','Machine'); codex login";

function installArgs(platform = process.platform) {
  return platform === 'win32'
    ? ['-NoLogo', '-NoExit', '-Command', WIN_INSTALL]
    : ['-ilc', POSIX_INSTALL];
}

function authArgs(platform = process.platform) {
  return platform === 'win32'
    ? ['-NoLogo', '-NoExit', '-Command', WIN_AUTH]
    : ['-ilc', 'codex login'];
}

function installGuide(platform = process.platform) {
  return {
    platform,
    installArgs: installArgs(platform),
    authArgs: authArgs(platform),
    installOk: INSTALL_OK,
    installFail: INSTALL_FAIL,
    docsUrl: DOCS_URL,
    run: 'codex',
  };
}

module.exports = { installGuide, installArgs, authArgs, INSTALL_OK, INSTALL_FAIL, DOCS_URL };
