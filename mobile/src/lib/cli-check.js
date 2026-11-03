// Before the phone asks the desktop for a new session, it checks the agent CLI that
// session would run is actually installed there. Without the check, a desktop with no
// `claude` (or `codex`) on PATH fails the spawn deep in main and the phone shows a raw
// error; with it, the user gets a sentence saying what to install and where.
//
// Plain JS rather than TypeScript so the repo's node:test suite can import it — see
// test/mobile-cli-check.test.mjs.

/**
 * @typedef {{ installed?: boolean, loggedIn?: boolean, version?: string | null,
 *   guide?: { docsUrl?: string } }} CliCheckResult
 * @typedef {{ title: string, message: string }} CliProblem
 */

/**
 * Which CLI a model id runs on. Codex models (`codex:…`) run the Codex CLI; Claude
 * models *and* local Ollama models (`ollama:…`, routed through a local proxy) run
 * the Claude CLI.
 *
 * @param {string | null | undefined} modelId
 * @returns {'claude' | 'codex'}
 */
export function cliForModel(modelId) {
  return typeof modelId === 'string' && modelId.startsWith('codex:') ? 'codex' : 'claude';
}

/**
 * The desktop request that probes that CLI.
 *
 * @param {string | null | undefined} modelId
 * @returns {'check-claude' | 'check-codex'}
 */
export function cliCheckChannel(modelId) {
  return cliForModel(modelId) === 'codex' ? 'check-codex' : 'check-claude';
}

/**
 * What's wrong with the CLI, as a title and message to show — or null when a session
 * can be created. An unanswerable check (an older desktop, a dropped request) is not
 * treated as "missing": the create goes ahead and fails on its own terms if it must.
 *
 * @param {'claude' | 'codex'} cli
 * @param {CliCheckResult | null | undefined} result
 * @returns {CliProblem | null}
 */
export function cliProblem(cli, result) {
  if (!result || typeof result !== 'object') return null;
  const docs = result.guide && result.guide.docsUrl ? `\n\nInstall guide: ${result.guide.docsUrl}` : '';
  if (cli === 'codex') {
    if (result.installed === false) {
      return {
        title: 'Codex CLI not installed',
        message: `The desktop can't start a Codex session because the Codex CLI isn't installed there. Install it on the computer (the desktop IDE walks you through it when you pick a Codex model), then try again.${docs}`,
      };
    }
    if (result.loggedIn === false) {
      return {
        title: 'Codex CLI not signed in',
        message: 'The Codex CLI on the desktop is installed but not signed in. Run `codex login` on the computer, then try again.',
      };
    }
    return null;
  }
  if (result.installed === false) {
    return {
      title: 'Claude Code not installed',
      message: `The desktop can't start a session because the Claude Code CLI isn't installed there. Open the IDE on the computer — it guides you through installing it — then try again.${docs}`,
    };
  }
  return null;
}
