# Architecture

Standard Electron main/preload/renderer split. The renderer is pure UI with **no** Node or OS access — everything that touches the OS lives in the main process and is reached over IPC declared in `preload.js`.

```
renderer.js  ──IPC(preload.js)──►  main.js  ──►  node-pty / git / http hook server
   (UI)                              (OS)
```

## main.js — three subsystems

1. **PTY manager.** One `pty.spawn(claude, ...)` per session, keyed by a generated UUID. The UUID is passed as `--session-id` so it round-trips inside hook payloads — that is how a hook event is matched back to its sidebar row. Sessions live in the `sessions` Map; `pty-input` / `pty-resize` / `kill-session` operate on it by id. Each session record also accumulates **what the agent did**: `firstPrompt` (its first `UserPromptSubmit`) and `edits` — a `Map<absPath, op[]>` recording every `PostToolUse` of a file tool (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) as a replayable op (`editOp()`). `recordSessionActivity()` fills these from the hook stream and pushes a `session-meta` event to the renderer (the file list is `[...edits.keys()]`); `commit-session` replays the ops to commit just that session's hunks (see [Per-session commit](#per-session-commit)). On the first prompt it also fires `generateSessionName()` — a one-shot `claude -p --model haiku` call (prompt over stdin, capped at 2000 chars) asking for a 2-4 word title, pushed to the renderer as `session-name`. Reuses the resolved `claude` CLI, so no API key or new dependency.
2. **Hook → status server.** A Node `http` server on a random `127.0.0.1` port. See [status-detection.md](status-detection.md).
3. **Git.** Plain `git` porcelain via `execFile` in `repoPath` (no git library). `git status --porcelain=v1` is parsed into staged/unstaged lists; stage = `git add`, unstage = `git reset HEAD` (falls back to `git rm --cached` for a repo with no commits); also `git commit -m`, `git-undo` (`git reset --soft HEAD~1` — undo the last commit, keep its changes staged) and `git push`. `commit-session` commits **only the hunks a single session edited** — see [Per-session commit](#per-session-commit). `git-diff` returns a file's unified diff (`--cached` for staged, `--no-index /dev/null <file>` for untracked) for the center-pane diff viewer. `git-revert` discards a file's changes — `git clean` for untracked, `git restore --staged --worktree` otherwise. `open-folder` runs `git rev-parse --show-toplevel` (`repoRoot()`) so porcelain paths and add/reset line up regardless of which subfolder the user picks. The chosen folder is written to `last-folder.txt` in `app.getPath('userData')` and reloaded on startup (`loadLastFolder()`), so the app reopens the last repo automatically; the renderer picks it up via its initial `refreshGit()`.

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

Keeps a `Map` of sessions, each owning its own xterm.js `Terminal` in a hidden container div. Switching sessions just toggles which container is visible, preserving scrollback. `setState()` sets the status-dot CSS class. The git pane re-fetches on demand (refresh button / after stage/unstage / after open-folder). A top `#session-bar` shows the active session's name on the left and a **Commit changes** button on the right that calls `commit-session` for that session only; `updateSessionBar()` refreshes it on select and on each `session-meta` event (button label shows the tracked file count). The name prefers the Haiku-generated title from `session-name` (which also updates the sidebar row label), falling back to the first prompt, then `session <id8>`. Clicking a git row calls `openFile()`, which routes by extension: images/audio open `#asset-view` (see Asset viewer), everything else opens `#diff-view` over the center pane — `renderDiff()` parses git's unified diff into coloured rows with old/new line-number gutters. Both overlays share `closeOverlay()`; selecting a session also hides them. Each row also has a two-click discard (rotate-ccw icon) button left of stage/unstage — the first click arms it red, the second calls `git-revert`. The "Changes" header carries matching stage-all (`+`) and discard-all (same rotate-ccw icon, same two-click arm) buttons that loop those calls over every unstaged file. The commit box has **Commit**, **Undo** (calls `git-undo` → `git reset --soft HEAD~1`, keeping the changes staged), and **Push**. Toolbar/action icons are inline Lucide SVGs chosen to read distinctly: refresh = `refresh-cw` (double arrow), discard = `rotate-ccw` (single arrow), undo = `undo-2` (hook arrow).

## File explorer

The left sidebar is split 50/50 by default: the sessions list on top, a file tree (`#file-tree`) below; a drag-gutter between them resizes the split (see [Resizable panes](#resizable-panes)). The tree is **lazy** — `loadDir(rel, container, depth)` fetches one directory level over `list-dir` (main reads `repoPath/<rel>` and returns `{name, dir}` entries, folders first then alphabetical, `.git` hidden) and only loads a folder's children the first time it's expanded (▸/▾ twisty). Clicking a file calls `openFromTree()`, which reuses the git pane's viewers: images/audio → `showAsset()`, everything else → `showFile()` — a read-only view that fetches the file's text over `read-text` and renders it into the `#diff-view` container with a single line-number gutter (binary files, sniffed by a NUL byte, show `(binary file)`; render is capped at 5000 lines). The tree refreshes on startup, on **Open folder**, and via its header ⟳ button — no auto-poll, since that would collapse expanded folders.

## Syntax highlighting

Both the diff (`renderDiff`) and the read-only file viewer (`renderText`) colour code with **highlight.js** — loaded as the prebuilt browser bundle `@highlightjs/cdn-assets` via plain `<script>`/`<link>` in `index.html` (no bundler), exposing `window.hljs`. The `vs2015` theme stylesheet supplies the `.hljs-*` token colours; rows keep their existing `.diff-code` background, so add/del/hunk colouring still shows through.

`langFor(file)` maps a file extension to an hljs language via `EXT_LANG` (covers python, js/ts, c#, c/c++, rust, go, swift, java, kotlin, ruby, php, bash, sql, json, yaml, xml, css, markdown, objc, …). Two grammars aren't in the common bundle and are loaded as extra self-registering scripts: **dos** (`.cmd`/`.bat`) and **powershell** (`.ps1`). Godot is handled without a dedicated grammar: `.gd` → python (GDScript is python-shaped) and `.import`/`.tscn`/`.tres`/`.cfg`/`.godot` → ini. Unknown extensions return `null` → the file viewer auto-detects (`hljs.highlightAuto`); the diff viewer leaves them plain.

- **File viewer** highlights the whole text once, then `hlLines()` splits the HTML into per-line fragments, re-opening any span left open across a newline so each gutter row stays balanced (correct for multi-line strings/comments).
- **Diff viewer** highlights each line in isolation via `hlLine()` — a hunk is a fragment with no whole-file context, so multi-line constructs may colour imperfectly; hunk headers (`@@`) stay plain.

## Asset viewer

Binary assets have no meaningful text diff, so clicking one in the git pane opens `#asset-view` instead. The renderer fetches the file's bytes as base64 over `read-asset` (`main.js` reads it from `repoPath`, returns `{ base64, mime }`) and builds a `data:` URL, then picks one of three views by type:

- **Pixel editor** — PNGs under 200×200. Drawn onto a `<canvas>`, blown up by an integer scale; left-drag paints/erases single pixels with the current palette/`<input type="color">` colour (the colour wheel). The −/+ toolbar buttons darken/lighten the selected colour by lerping toward black/white. Mouse wheel changes the integer zoom; middle-button drag pans (via `assetBody` scroll), while a middle click without dragging eyedrops the pixel underneath. Undo/redo (↶/↷ buttons or Ctrl+Z / Ctrl+Y, capped at 50 `ImageData` snapshots) is pushed once per stroke. **Save** sends `canvas.toDataURL()` bytes back over `write-asset` and refreshes git.
- **Image zoom** — any other image. An `<img>` with −/+/reset buttons scaling its width.
- **Audio + waveform** — `wav`/`ogg`/`mp3`. An `<audio controls>` for playback plus a peak-per-column waveform drawn from `AudioContext.decodeAudioData` (base64 → `ArrayBuffer`, no network).

`data:` URLs for `<img>`/`<audio>` require the CSP in `index.html` to allow `img-src`/`media-src 'self' data:`.

## Resizable panes

Four drag-gutters (`.gutter` divs in `index.html`) let the user resize, **not reorder**, the panes. The column layout is a CSS grid whose left/right tracks are the vars `--left`/`--right` on `#app` (`grid-template-columns: var(--left) 5px minmax(0,1fr) 5px var(--right)`); the center is the remaining `1fr`. The sidebar split is the var `--sess-h` on `#sidebar` (`#sessions-pane`'s flex-basis; `#files-pane` takes the rest). The git pane is itself split vertically: `#git-main` (status/commit) fills the top and `#git-console` takes a `--console-h` flex-basis at the bottom (default `33%`); see [Git-pane console](#git-pane-console).

`renderer.js`'s `resizer(gutter, axis, sign, read, write, min, max)` is one generic pointer-drag handler wired four times — left column, right column, sidebar split, git-pane console split. It pointer-captures the gutter, then on move clamps `base + sign*delta` to `[min, max()]` and writes the var. Clamps keep every pane within bounds: columns can't shrink the center below `CENTER_MIN` (200px) or themselves below their mins; the sessions pane stays ≥80px and leaves ≥140px for the explorer; the console stays ≥80px and leaves ≥160px for the git content. `sign` is `-1` for the right and console gutters (their pane is on the far side, so dragging toward it shrinks it). Each move calls `fit()` so the active terminal reflows live, plus `fitConsole()` for the console terminal. Sizes are session-only — not persisted across restarts.

## Git-pane console

The bottom of the git pane (`#git-console`) holds one shared interactive shell terminal — an xterm.js `Terminal` (`initConsole()` in `renderer.js`) backed by a single shell PTY in the main process (`spawnConsole()` in `main.js`: `powershell.exe`/`COMSPEC` on Windows, `$SHELL` otherwise, spawned in `repoPath`). It is independent of the per-session Claude PTYs and is **not** keyed by id — IPC is `term-start` (idempotent spawn), `term-input`, `term-resize`, and the `term-data`/`term-exit` events. When the shell exits (e.g. the user types `exit`), `main.js` drops the PTY and emits `term-exit`; the renderer respawns a fresh one via `startShell()`. The `TERMINAL` pane header carries a right-aligned **Clear** button (`#term-clear`) that calls `term.clear()` (renderer-only; doesn't touch the shell).

## Terminal links & inline browser

Ctrl+click (Cmd on mac) in a terminal opens what's under the cursor — a web URL in an inline browser, a file path in the explorer's viewer (VS Code's gesture). `registerTerminalLinks(term)` wires each session's xterm via `registerLinkProvider`. The provider is **gated on the modifier key**: a window-level `keydown`/`keyup` pair tracks `linkModDown`, and `provideLinks` returns nothing unless it's held — so links only underline/cursor while Ctrl is down, and normal hover and drag-to-select are untouched. `findTerminalLinks(lineText)` scans a row for `http(s)://` URLs first, then path-ish tokens (`PATH_RE`), claiming character ranges so the two never overlap. A path token only counts if it has a separator or a known extension (`looksLikePath` against `PATH_EXT`, built from `EXT_LANG`/`IMG_EXT`/`AUDIO_EXT`); a trailing `:line[:col]` is split off on activation and passed to the viewer's jump.

`openTerminalLink` routes by kind: a URL → `showWeb()`; a path → `resolve-link-path` (main resolves an absolute path as-is, else against `repoPath` = the session cwd, and reports `isFile`/`inRepo`/`rel`), then in-repo files open via `openFromTree(rel, {line})` and anything else goes to the OS through `open-external`. `showWeb()` is a center overlay (`#web-view`, peer of the diff/asset overlays, hidden by the shared `closeOverlay()` and on session select) holding a back/forward/reload/address/open-externally bar and an Electron **`<webview>`** — a separate guest process, so the host-page CSP doesn't restrict the loaded site. It requires `webviewTag: true` in the window's `webPreferences`. `did-navigate`/`did-navigate-in-page` keep the address bar in sync; the ↗ button hands the current URL to `open-external` (→ `shell.openExternal`).

## preload.js

The entire IPC surface (`contextBridge.exposeInMainWorld('api', …)`). Add a channel here when wiring any new main↔renderer call. `resolve-link-path` and `open-external` back the terminal link feature above.

## Files

`main.js` (main process), `preload.js` (IPC bridge), `index.html` + `renderer.js` + `styles.css` (UI). Vanilla JS, no bundler, no test framework.
