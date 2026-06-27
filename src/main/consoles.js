const { ipcMain } = require('electron');
const path = require('path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');

// --- git-pane consoles: interactive shell PTYs in the repo dir, keyed by id.
// The renderer shows one tab per terminal. A terminal may run a launch config /
// task command, which is written into the freshly-spawned shell.
const consoles = new Map(); // id -> pty

// Shells the user can pick from the + menu. The `name` becomes the tab label.
function availableShells() {
  if (process.platform === 'win32') {
    return [
      { name: 'ps', path: 'powershell.exe' },
      { name: 'cmd', path: process.env.COMSPEC || 'cmd.exe' },
    ];
  }
  const sh = process.env.SHELL || '/bin/bash';
  return [{ name: path.basename(sh).replace(/\.exe$/i, ''), path: sh }];
}

// Spawn a shell PTY under `id` (reused across restarts so term-data keeps routing
// to the same tab). The onExit guard ignores a pty we've already replaced, so a
// restart doesn't tear down its successor or report the tab as closed.
//
// `args` are passed straight to the shell as argv — the way to run a command
// *reliably*, by spawning e.g. `zsh -ilc '<cmd>'` rather than typing into an
// interactive prompt (which races the shell's line editor; see the setup gate). When
// `args` carry the command there is no `command` to type, so the deferred-write below
// stays inert.
function spawnConsole(id, { cols, rows, shell, args, command, cwd, env } = {}) {
  const shPath = shell || availableShells()[0].path;
  const p = pty.spawn(shPath, args || [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || getRepoPath(),
    env: env ? { ...process.env, ...env } : process.env,
  });
  // Run `command` only once the shell is ready to accept it. Writing it the instant
  // the PTY spawns races the shell's startup: zsh in particular hasn't initialised
  // its line editor (ZLE) until it has sourced its rc files and printed its first
  // prompt, so an early write lands the text but drops the submitting Enter (\r) —
  // the command appears but never runs. Waiting for the shell's first output (its
  // prompt) means ZLE is up before we type. A timeout backstops a silent shell.
  let cmdSent = !command;
  const sendCommand = () => { if (!cmdSent) { cmdSent = true; p.write(command + '\r'); } };
  p.onData((data) => {
    sendToRenderer('term-data', { id, data });
    sendCommand();
  });
  p.onExit(() => {
    if (consoles.get(id) !== p) return; // replaced by a restart — stay quiet
    consoles.delete(id);
    sendToRenderer('term-exit', { id });
  });
  consoles.set(id, p);
  if (command) setTimeout(sendCommand, 2000);
  return p;
}

ipcMain.handle('term-shells', () => availableShells());
ipcMain.handle('term-create', (_e, opts = {}) => {
  const id = crypto.randomUUID();
  spawnConsole(id, opts);
  return { id };
});
// Relaunch a config into an existing tab: kill the old pty (its onExit is silenced
// by the guard above once we've removed it) and spawn a fresh one under the same id.
ipcMain.handle('term-restart', (_e, opts = {}) => {
  const old = consoles.get(opts.id);
  if (old) { consoles.delete(opts.id); try { old.kill(); } catch { /* already gone */ } }
  spawnConsole(opts.id, opts);
  return { ok: true };
});
ipcMain.on('term-input', (_e, { id, data }) => { const p = consoles.get(id); if (p) p.write(data); });
ipcMain.on('term-resize', (_e, { id, cols, rows }) => {
  const p = consoles.get(id);
  if (p) try { p.resize(cols, rows); } catch { /* race on close */ }
});
ipcMain.on('term-kill', (_e, { id }) => {
  const p = consoles.get(id);
  if (p) { consoles.delete(id); try { p.kill(); } catch { /* already gone */ } }
});

module.exports = {};
