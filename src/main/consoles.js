const bridge = require('./remote-bridge');
const path = require('path');
const fs = require('fs');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { cleanEnv } = require('./proc-env');

// --- git-pane consoles: interactive shell PTYs in the repo dir, keyed by id.
// The renderer shows one tab per terminal. A terminal may run a launch config /
// task command, which is written into the freshly-spawned shell.
//
// Main is the source of truth for what's open: each entry carries the terminal's
// name and kind (the desktop renderer sends both, so naming has one owner), and
// every open/close pushes `terminals-changed`. That's what lets a phone list the
// terminals, tell which launch configs are running (kind 'config' names), and stop
// one — the desktop's own toolbar keeps deriving that from its local tab map.
const consoles = new Map(); // id -> { pty, name, kind, scroll }

// A phone that opens a terminal gets a fresh WebView with an empty xterm, so it
// needs the output that already scrolled by. Main keeps a bounded tail per
// terminal, stamped with a counter so the client can drop the live chunks that
// raced its snapshot request (same scheme as session scrollback).
//
// This is the ceiling on everything a phone can ever scroll back to: what main drops
// off the front, no client can ask for again. It's deliberately generous — a build or
// a dev server logs a lot, and the answer you came to read is usually the *first*
// error, not the last line. The phone's xterm keeps a matching row budget
// (`scrollback` in mobile/src/components/XtermWebView.tsx): raising either alone does
// nothing, since whichever is smaller is what actually truncates the output.
const SCROLL_MAX = 1_000_000;
const newScroll = () => ({ chunks: [], len: 0, seq: 0 });

function pushScroll(scroll, data) {
  scroll.seq++;
  scroll.chunks.push(data);
  scroll.len += data.length;
  while (scroll.len > SCROLL_MAX && scroll.chunks.length > 1) scroll.len -= scroll.chunks.shift().length;
}

const terminalList = () =>
  [...consoles.entries()].map(([id, c]) => ({ id, name: c.name, kind: c.kind }));

function broadcastTerminals() { sendToRenderer('terminals-changed', terminalList()); }

// Kill a terminal and tell everyone. Unlike the pty's own onExit (which stays
// quiet for a terminal we replaced), this always pushes `term-exit`, so the
// desktop closes the tab even when the kill came from a phone.
function killConsole(id) {
  const c = consoles.get(id);
  if (!c) return;
  consoles.delete(id);
  try { c.pty.kill(); } catch { /* already gone */ }
  sendToRenderer('term-exit', { id });
  broadcastTerminals();
}

// Stop a launch config: close the terminal(s) it started. A config "runs" for
// exactly as long as its terminal is open — the definition the desktop toolbar
// uses, and the one a phone derives from `terminals-changed`.
function stopConfigNamed(name) {
  for (const [id, c] of [...consoles]) {
    if (c.kind === 'config' && c.name === name) killConsole(id);
  }
}

// Shells the user can pick from the + menu. The `name` becomes the tab label.
function availableShells() {
  if (process.platform === 'win32') {
    return [
      { name: 'ps', path: 'powershell.exe' },
      { name: 'cmd', path: process.env.COMSPEC || 'cmd.exe' },
    ];
  }
  // Offer the user's login shell first, then the other common shells that are
  // actually installed — so a broken/misconfigured zsh isn't the only option.
  // $SHELL can be unset for a GUI-launched .app (Finder/Dock don't export it), so
  // we also probe the standard system paths plus Homebrew prefixes (Apple Silicon
  // /opt/homebrew, Intel /usr/local) where macOS users install modern shells.
  const candidates = [
    process.env.SHELL,
    '/bin/zsh', '/bin/bash', '/bin/sh',
    '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/bash', '/opt/homebrew/bin/fish',
    '/usr/local/bin/zsh', '/usr/local/bin/bash', '/usr/local/bin/fish',
  ];
  const shells = [];
  const seen = new Set();
  for (const sh of candidates) {
    if (!sh || seen.has(sh) || !fs.existsSync(sh)) continue;
    seen.add(sh);
    shells.push({ name: path.basename(sh).replace(/\.exe$/i, ''), path: sh });
  }
  // Fall back to bash by name if nothing on disk matched (e.g. an exotic $SHELL).
  return shells.length ? shells : [{ name: 'bash', path: process.env.SHELL || '/bin/bash' }];
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
function spawnConsole(id, { cols, rows, shell, args, command, cwd, env, name, kind } = {}) {
  const shPath = shell || availableShells()[0].path;
  let p;
  try {
    p = pty.spawn(shPath, args || [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      // Home as the last resort: with no project open yet, a null cwd would crash the spawn.
      cwd: cwd || getRepoPath() || require('os').homedir(),
      // Scrub VS Code debugger/inspector pollution: a console may run the `claude` CLI
      // (the setup gate's install/auth terminal does), itself a Node process that would
      // otherwise boot debug-attached and fail — the reason the install died here but
      // worked in a clean Terminal. See src/main/proc-env.js.
      env: env ? { ...cleanEnv(), ...env } : cleanEnv(),
    });
  } catch (e) {
    // A bad shell path / cwd / winpty hiccup must never take the app down: report the
    // tab as exited (the renderer reopens a default shell) and bail out of this spawn.
    console.error('[console] spawn failed', e);
    consoles.delete(id);
    sendToRenderer('term-exit', { id });
    broadcastTerminals();
    return null;
  }
  // The renderer names the tab; main just records what it was told, so the two
  // never disagree about what a terminal is called. A restart reuses the id but
  // starts a fresh shell, so its scrollback starts over too.
  const entry = {
    pty: p,
    name: name || 'shell',
    kind: kind || 'shell',
    scroll: newScroll(),
  };
  consoles.set(id, entry);
  // Run `command` only once the shell is ready to accept it. Writing it the instant
  // the PTY spawns races the shell's startup: zsh in particular hasn't initialised
  // its line editor (ZLE) until it has sourced its rc files and printed its first
  // prompt, so an early write lands the text but drops the submitting Enter (\r) —
  // the command appears but never runs. Waiting for the shell's first output (its
  // prompt) means ZLE is up before we type. A timeout backstops a silent shell.
  let cmdSent = !command;
  const sendCommand = () => {
    if (cmdSent) return;
    cmdSent = true;
    // The pty can die between spawn and this deferred/onData write (process exits
    // immediately, conpty teardown races). A throw here lands in a setTimeout/onData
    // callback with no caller to catch it — exactly the kind of stray error that would
    // otherwise crash the whole app. Swallow it; onExit cleans up the tab.
    try { p.write(command + '\r'); } catch (e) { console.error('[console] command write failed', e); }
  };
  p.onData((data) => {
    pushScroll(entry.scroll, data);
    sendToRenderer('term-data', { id, data, seq: entry.scroll.seq });
    sendCommand();
  });
  p.onExit(() => {
    if (consoles.get(id) !== entry) return; // replaced by a restart — stay quiet
    consoles.delete(id);
    sendToRenderer('term-exit', { id });
    broadcastTerminals();
  });
  if (command) setTimeout(sendCommand, 2000);
  return p;
}

bridge.handle('term-shells', () => availableShells());
bridge.handle('term-create', (_e, opts = {}) => {
  const id = crypto.randomUUID();
  spawnConsole(id, opts);
  broadcastTerminals();
  return { id };
});
// Relaunch a config into an existing tab: kill the old pty (its onExit is silenced
// by the guard above once we've removed it) and spawn a fresh one under the same id.
bridge.handle('term-restart', (_e, opts = {}) => {
  const old = consoles.get(opts.id);
  if (old) { consoles.delete(opts.id); try { old.pty.kill(); } catch { /* already gone */ } }
  spawnConsole(opts.id, { ...opts, name: opts.name || (old && old.name), kind: opts.kind || (old && old.kind) });
  broadcastTerminals();
  return { ok: true };
});
bridge.handle('term-list', () => terminalList());
// The output a terminal has produced so far, for a client attaching to one that's
// already running. `seq` is the counter of the last chunk included, so the client
// can drop live chunks it already has.
bridge.handle('term-scrollback', (_e, id) => {
  const c = consoles.get(id);
  if (!c) return { data: '', seq: 0 };
  return { data: c.scroll.chunks.join(''), seq: c.scroll.seq };
});
bridge.on('term-input', (_e, { id, data }) => {
  const c = consoles.get(id);
  if (c) try { c.pty.write(data); } catch { /* pty closed under us — drop the keystroke, don't crash */ }
});
bridge.on('term-resize', (_e, { id, cols, rows }) => {
  const c = consoles.get(id);
  if (c) try { c.pty.resize(cols, rows); } catch { /* race on close */ }
});
bridge.on('term-kill', (_e, { id }) => killConsole(id));

module.exports = { stopConfigNamed };
