# Architecture

Standard Electron main/preload/renderer split. The renderer is pure UI with **no** Node or OS access — everything that touches the OS lives in the main process and is reached over IPC declared in `preload.js`.

```
renderer.js  ──IPC(preload.js)──►  main.js  ──►  node-pty / git / http hook server
   (UI)                              (OS)
```

## main.js — three subsystems

1. **PTY manager.** One `pty.spawn(claude, ...)` per session, keyed by a generated UUID. The UUID is passed as `--session-id` so it round-trips inside hook payloads — that is how a hook event is matched back to its sidebar row. Sessions live in the `sessions` Map; `pty-input` / `pty-resize` / `kill-session` operate on it by id.
2. **Hook → status server.** A Node `http` server on a random `127.0.0.1` port. See [status-detection.md](status-detection.md).
3. **Git.** Plain `git` porcelain via `execFile` in `repoPath` (no git library). `git status --porcelain=v1` is parsed into staged/unstaged lists; stage = `git add`, unstage = `git reset HEAD` (falls back to `git rm --cached` for a repo with no commits); also `git commit -m` and `git push`. `git-diff` returns a file's unified diff (`--cached` for staged, `--no-index /dev/null <file>` for untracked) for the center-pane diff viewer. `open-folder` runs `git rev-parse --show-toplevel` (`repoRoot()`) so porcelain paths and add/reset line up regardless of which subfolder the user picks. The chosen folder is written to `last-folder.txt` in `app.getPath('userData')` and reloaded on startup (`loadLastFolder()`), so the app reopens the last repo automatically; the renderer picks it up via its initial `refreshGit()`.

## renderer.js

Keeps a `Map` of sessions, each owning its own xterm.js `Terminal` in a hidden container div. Switching sessions just toggles which container is visible, preserving scrollback. `setState()` sets the status-dot CSS class. The git pane re-fetches on demand (refresh button / after stage/unstage / after open-folder). Clicking a git file name opens `#diff-view` over the center pane: `renderDiff()` parses git's unified diff into coloured rows with old/new line-number gutters; selecting a session or the close button hides it.

## preload.js

The entire IPC surface (`contextBridge.exposeInMainWorld('api', …)`). Add a channel here when wiring any new main↔renderer call.

## Files

`main.js` (main process), `preload.js` (IPC bridge), `index.html` + `renderer.js` + `styles.css` (UI). Vanilla JS, no bundler, no test framework.
