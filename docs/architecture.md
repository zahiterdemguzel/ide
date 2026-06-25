# Architecture

Standard Electron main/preload/renderer split. The renderer is pure UI with **no** Node or OS access — everything that touches the OS lives in the main process and is reached over IPC declared in `preload.js`.

```
renderer.js  ──IPC(preload.js)──►  main.js  ──►  node-pty / git / http hook server
   (UI)                              (OS)
```

## main.js — three subsystems

1. **PTY manager.** One `pty.spawn(claude, ...)` per session, keyed by a generated UUID. The UUID is passed as `--session-id` so it round-trips inside hook payloads — that is how a hook event is matched back to its sidebar row. Sessions live in the `sessions` Map; `pty-input` / `pty-resize` / `kill-session` operate on it by id. Each session record also accumulates **what the agent did**: `firstPrompt` (its first `UserPromptSubmit`) and `edits` — a `Map<absPath, op[]>` recording every `PostToolUse` of a file tool (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) as a replayable op (`editOp()`). `recordSessionActivity()` fills these from the hook stream and pushes a `session-meta` event to the renderer (the file list is `[...edits.keys()]`); `commit-session` replays the ops to commit just that session's hunks (see [Per-session commit](#per-session-commit)). On the first prompt it also fires `generateSessionName()` — a one-shot `claude -p --model haiku` call (prompt over stdin, capped at 2000 chars) asking for a 2-4 word title, pushed to the renderer as `session-name`. Reuses the resolved `claude` CLI, so no API key or new dependency.
2. **Hook → status server.** A Node `http` server on a random `127.0.0.1` port. See [status-detection.md](status-detection.md).
3. **Git.** Plain `git` porcelain via `execFile` in `repoPath` (no git library). `git status --porcelain=v1` is parsed into staged/unstaged lists; stage = `git add`, unstage = `git reset HEAD` (falls back to `git rm --cached` for a repo with no commits); also `git commit -m` and `git push`. `commit-session` commits **only the hunks a single session edited** — see [Per-session commit](#per-session-commit). `git-diff` returns a file's unified diff (`--cached` for staged, `--no-index /dev/null <file>` for untracked) for the center-pane diff viewer. `git-revert` discards a file's changes — `git clean` for untracked, `git restore --staged --worktree` otherwise. `open-folder` runs `git rev-parse --show-toplevel` (`repoRoot()`) so porcelain paths and add/reset line up regardless of which subfolder the user picks. The chosen folder is written to `last-folder.txt` in `app.getPath('userData')` and reloaded on startup (`loadLastFolder()`), so the app reopens the last repo automatically; the renderer picks it up via its initial `refreshGit()`.

## Per-session commit

Each session is tracked independently so its work can be committed on its own, **even when two sessions edit the same file** — each commit then contains only the lines that session changed.

**Tracking (record).** Every hook payload carries the `--session-id` we spawned with, so `recordSessionActivity()` can attribute it. Per session it keeps:

- `firstPrompt` — the first `UserPromptSubmit`, reused as the commit message (and as the seed for the Haiku-generated session title).
- `edits` — a `Map<absPath, op[]>`. Every `PostToolUse` of a file tool becomes a *replayable op* via `editOp()`: `Write` → `{t:'write', content}`, `Edit` → `{t:'edit', old, new, all}`, `MultiEdit` → `{t:'multi', edits}`, `NotebookEdit` → `{t:'opaque'}` (can't be replayed as text).

**Commit (replay).** `commit-session(id)` rebuilds, for each touched file, *only this session's version*:

1. `replayEdits(base, ops)` replays the session's ops onto the file's committed (`HEAD`) contents — `base` comes from `git show HEAD:<path>` (empty for a new file). String replacement, in order. It returns `{content, clean}`; `clean` is false if an `old_string` is no longer present (the other session moved/overwrote it) or the op was opaque.
2. If `clean`, the synthesized `content` is committed. If not, that file falls back to its **whole current working-tree contents** (best effort — overlapping same-line edits are inherently ambiguous).
3. `commitBlobs(entries, msg)` commits those blobs **without touching the working tree or the real index's other entries**: it seeds a throwaway index (`GIT_INDEX_FILE` in a tmp file) from `HEAD`, `hash-object -w`s each synthesized blob, `update-index`es them into that throwaway index, then `write-tree` → `commit-tree -p HEAD` → `update-ref HEAD`. Finally it syncs the **real** index for *just those paths* to the new blobs, so the committed lines read as clean and only the *other* session's edits remain as unstaged changes.

Because step 3 commits a synthesized blob rather than the shared working file, the other session's edits to the same file are never swept in — they stay in the working tree for that session to commit later (replaying onto the now-updated `HEAD`).

**Known ceilings.** Two sessions editing the *exact same lines* → the second replays unclean and falls back to a whole-file commit. `NotebookEdit` is always whole-file. A version of a session's file the user manually staged is overwritten in the index by the synthesized blob. This relies on Claude Code's `PostToolUse` payload exposing `tool_input.old_string`/`new_string`/`content`.

## renderer.js

Keeps a `Map` of sessions, each owning its own xterm.js `Terminal` in a hidden container div. Switching sessions just toggles which container is visible, preserving scrollback. `setState()` sets the status-dot CSS class. The git pane re-fetches on demand (refresh button / after stage/unstage / after open-folder). A top `#session-bar` shows the active session's name on the left and a **Commit changes** button on the right that calls `commit-session` for that session only; `updateSessionBar()` refreshes it on select and on each `session-meta` event (button label shows the tracked file count). The name prefers the Haiku-generated title from `session-name` (which also updates the sidebar row label), falling back to the first prompt, then `session <id8>`. Clicking a git row calls `openFile()`, which routes by extension: images/audio open `#asset-view` (see Asset viewer), everything else opens `#diff-view` over the center pane — `renderDiff()` parses git's unified diff into coloured rows with old/new line-number gutters. Both overlays share `closeOverlay()`; selecting a session also hides them. Each row also has a two-click discard (`⟲`) button left of stage/unstage — the first click arms it red, the second calls `git-revert`. The "Changes" header carries matching stage-all (`+`) and discard-all (`⟲`, same two-click arm) buttons that loop those calls over every unstaged file.

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
