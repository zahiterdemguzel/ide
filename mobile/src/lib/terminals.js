// Pure helpers behind the Run panel's terminal actions: which shells the phone
// itself opened (and the grid it sized them to), and how a listed terminal can be
// restarted faithfully. Plain JS so node:test can import it — see
// test/mobile-terminals.test.mjs.

/**
 * @typedef {{ id: string, name: string, kind: string }} TerminalInfo
 * @typedef {{ launch: { name: string }[], tasks: { name: string }[] }} RunConfigs
 * @typedef {{ cols: number, rows: number }} Grid
 */

// A shell opened from the phone has no desktop tab (the desktop renderer only
// shows terminals it created), so the phone is free to size its PTY. Remembered
// for this app session only — after a relaunch such a shell is treated like any
// other terminal and mirrored rather than resized.
/** @type {Map<string, Grid | null>} */
const phoneOwned = new Map();

/** @param {string} id */
export function markPhoneOwned(id) {
  if (!phoneOwned.has(id)) phoneOwned.set(id, null);
}

/** @param {string} id */
export function isPhoneOwned(id) {
  return phoneOwned.has(id);
}

/** @param {string} id @param {number} cols @param {number} rows */
export function rememberGrid(id, cols, rows) {
  if (phoneOwned.has(id) && cols > 0 && rows > 0) phoneOwned.set(id, { cols, rows });
}

/** @param {string} id @returns {Grid | null} */
export function gridFor(id) {
  return phoneOwned.get(id) ?? null;
}

/** @param {string} id */
export function forgetTerminal(id) {
  phoneOwned.delete(id);
}

/**
 * How to restart a listed terminal, or null when it can't be done faithfully.
 *
 * - A launch config / task terminal reruns through `run-config-start`, the same
 *   path the play button takes: `term-restart` alone would respawn a bare shell
 *   without the config's command, cwd and env.
 * - A plain shell respawns in place with `term-restart` (same id, so the desktop
 *   tab and any attached phone keep listening), at the phone's grid when the
 *   phone owns it.
 * - Anything else (a "run this file" tab, the Claude login terminal) carries a
 *   command only the desktop renderer knows, so it is not offered.
 *
 * @param {TerminalInfo} terminal
 * @param {RunConfigs} configs
 * @param {Grid | null} [grid]
 * @returns {{ via: 'run-config-start', args: { kind: 'launch' | 'task', name: string } }
 *   | { via: 'term-restart', args: { id: string, cols?: number, rows?: number } }
 *   | null}
 */
export function restartPlan(terminal, configs, grid = null) {
  if (terminal.kind === 'config') {
    if (configs.launch.some((c) => c.name === terminal.name)) {
      return { via: 'run-config-start', args: { kind: 'launch', name: terminal.name } };
    }
    if (configs.tasks.some((t) => t.name === terminal.name)) {
      return { via: 'run-config-start', args: { kind: 'task', name: terminal.name } };
    }
    return null;
  }
  if (terminal.kind === 'shell') {
    return { via: 'term-restart', args: grid ? { id: terminal.id, ...grid } : { id: terminal.id } };
  }
  return null;
}
