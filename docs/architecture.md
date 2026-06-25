# Architecture

Standard Electron main/preload/renderer split. The renderer is pure UI with **no** Node or OS access — everything that touches the OS lives in the main process and is reached over IPC declared in `preload.js`.

```
renderer.js  ──IPC(preload.js)──►  main.js  ──►  node-pty / git / http hook server
   (UI)                              (OS)
```

## main.js — three subsystems

1. **PTY manager.** One `pty.spawn(claude, ...)` per session, keyed by a generated UUID. The UUID is passed as `--session-id` so it round-trips inside hook payloads — that is how a hook event is matched back to its sidebar row. Sessions live in the `sessions` Map; `pty-input` / `pty-resize` / `kill-session` operate on it by id. Each session record also accumulates **what the agent did**: `firstPrompt` (its first `UserPromptSubmit`) and `files` (a Set of paths from every `PostToolUse` of a `FILE_TOOLS` edit — `Write`/`Edit`/`MultiEdit`/`NotebookEdit`). `recordSessionActivity()` fills these from the hook stream and pushes a `session-meta` event to the renderer; `commit-session` uses them to commit just that session's files (see Git).
2. **Hook → status server.** A Node `http` server on a random `127.0.0.1` port. See [status-detection.md](status-detection.md).
3. **Git.** Plain `git` porcelain via `execFile` in `repoPath` (no git library). `git status --porcelain=v1` is parsed into staged/unstaged lists; stage = `git add`, unstage = `git reset HEAD` (falls back to `git rm --cached` for a repo with no commits); also `git commit -m` and `git push`. `commit-session` commits **only the files a single session edited** (path-scoped `git add` + `git commit -- <files>`), using that session's `firstPrompt` as the message — other sessions' staged/unstaged work is left untouched. `git-diff` returns a file's unified diff (`--cached` for staged, `--no-index /dev/null <file>` for untracked) for the center-pane diff viewer. `git-revert` discards a file's changes — `git clean` for untracked, `git restore --staged --worktree` otherwise. `open-folder` runs `git rev-parse --show-toplevel` (`repoRoot()`) so porcelain paths and add/reset line up regardless of which subfolder the user picks. The chosen folder is written to `last-folder.txt` in `app.getPath('userData')` and reloaded on startup (`loadLastFolder()`), so the app reopens the last repo automatically; the renderer picks it up via its initial `refreshGit()`.

## renderer.js

Keeps a `Map` of sessions, each owning its own xterm.js `Terminal` in a hidden container div. Switching sessions just toggles which container is visible, preserving scrollback. `setState()` sets the status-dot CSS class. The git pane re-fetches on demand (refresh button / after stage/unstage / after open-folder). A top `#session-bar` shows the active session's name (its first prompt) on the left and a **Commit changes** button on the right that calls `commit-session` for that session only; `updateSessionBar()` refreshes it on select and on each `session-meta` event (button label shows the tracked file count). Clicking a git row calls `openFile()`, which routes by extension: images/audio open `#asset-view` (see Asset viewer), everything else opens `#diff-view` over the center pane — `renderDiff()` parses git's unified diff into coloured rows with old/new line-number gutters. Both overlays share `closeOverlay()`; selecting a session also hides them. Each row also has a two-click discard (`⟲`) button left of stage/unstage — the first click arms it red, the second calls `git-revert`. The "Changes" header carries matching stage-all (`+`) and discard-all (`⟲`, same two-click arm) buttons that loop those calls over every unstaged file.

## Asset viewer

Binary assets have no meaningful text diff, so clicking one in the git pane opens `#asset-view` instead. The renderer fetches the file's bytes as base64 over `read-asset` (`main.js` reads it from `repoPath`, returns `{ base64, mime }`) and builds a `data:` URL, then picks one of three views by type:

- **Pixel editor** — PNGs under 200×200. Drawn onto a `<canvas>`, blown up by an integer scale; pointer drag paints/erases single pixels with the current palette/`<input type="color">` colour. **Save** sends `canvas.toDataURL()` bytes back over `write-asset` and refreshes git.
- **Image zoom** — any other image. An `<img>` with −/+/reset buttons scaling its width.
- **Audio + waveform** — `wav`/`ogg`/`mp3`. An `<audio controls>` for playback plus a peak-per-column waveform drawn from `AudioContext.decodeAudioData` (base64 → `ArrayBuffer`, no network).

`data:` URLs for `<img>`/`<audio>` require the CSP in `index.html` to allow `img-src`/`media-src 'self' data:`.

## preload.js

The entire IPC surface (`contextBridge.exposeInMainWorld('api', …)`). Add a channel here when wiring any new main↔renderer call.

## Files

`main.js` (main process), `preload.js` (IPC bridge), `index.html` + `renderer.js` + `styles.css` (UI). Vanilla JS, no bundler, no test framework.
