# Testing, lint & CI

The app has no automated GUI/end-to-end harness, but the **pure, subtle logic** — the parts most likely to break silently under an edit — is split out into Electron-free modules and unit-tested with Node's built-in runner. There is **no test-framework dependency**: `npm test` is `node --test`.

## Running

- `npm test` — runs every file under `test/` (`node --test`'s default glob).
- `npm run lint` — ESLint (flat config in `eslint.config.js`) over the whole tree.

CI (`.github/workflows/ci.yml`) runs both on every push to `master` and every PR. It skips the Electron binary download (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) because nothing under test needs it.

## The testability split

A module that does `require('electron')` (or reads files, spawns git, touches the DOM) can't be loaded under plain Node. So the rule is: **keep the OS/IPC shell thin and put the real logic in an Electron-free helper next to it.** This mirrors the existing `edit-ops.js` (pure) ↔ `session-commit.js` (IPC) split.

| Helper (pure, tested) | Shell (IPC/IO, untested) | What's covered |
|---|---|---|
| `src/main/edit-ops.js` | `src/main/session-commit.js` | `editOp`/`replayEdits`/`inverseEdits` — turning file-tool calls into replayable ops and replaying / de-applying them (the per-session commit/revert core, including the cross-session "don't clobber the other session's edits" guarantee). |
| `src/main/run-configs-lib.js` | `src/main/run-configs.js` | `parseJsonc` (comments, trailing commas, comment-like text inside strings) and the launch/task → shell-command translation (`buildLaunchCommand`, `buildTaskCommand`, `resolveTask`, `chainCommands`). Platform-specific behaviour (PowerShell `$?` chaining vs `&&`) is tested by **injecting** the platform into `makeRunConfigLib(repoPath, platform)`. |
| `src/main/runners-lib.js` | `src/main/runners.js` | `langForFile` (extension → language, case-insensitive, non-runnable types) and `buildRunCommand` (interpreter + file → quoted command line, incl. `go run`/`powershell -File`/`deno run` shapes and appended args) — the [run-a-file](architecture.md#run-a-file) translation. runners.js owns PATH probing, the interpreter store, and IPC. |
| `src/main/git-parse.js` | `src/main/git.js`, `src/main/session-commit.js` | `parsePorcelain` (staged/unstaged/conflicts split, rename arrows, unmerged states, non-ASCII paths), `parseLog` (unit-separator field splitting), `filterCommits` (History-search term matching across subject/author/hash), and `sumNumstat` (totals a `git diff --numstat` into additions/deletions/files for the per-session Diff badge, counting a binary file as a changed file with 0 lines). git.js / session-commit.js run the subprocess and feed stdout here. |
| `src/main/search-ignore.js` | `src/main/explorer.js` | `shouldSkipDir` — which dirs the explorer's filename walk (`search-names`/`list-files`) skips: named dependency/build dirs across ecosystems (`node_modules`, `venv`, `target`, `dist`, …) plus any un-allowlisted dot-dir — and `GREP_EXCLUDE_PATHSPECS`, the matching `git grep` excludes for the references search (`search-refs`). Tested for the dot-dir catch-all/allowlist split and that the grep pathspecs stay pure-exclude (a positive pathspec would silently flip grep into search-only-these mode). |
| `src/main/recent-folders.js` | `src/main/repo.js` | `addRecent` — front-insert + dedup + cap for the Open-folder recent-projects list (the reverse-combobox). repo.js handles the file persistence and IPC. |
| `src/main/cli-args.js` | `src/main/repo.js` | `parseFolderArg` — the `--folder <path>` / `--folder=<path>` (alias `--dir`) override that makes a launched instance open a given directory instead of the persisted last folder (both flag forms, first-occurrence-wins, missing/empty value, non-array argv). repo.js reads `process.argv`, validates the path exists, and applies it without writing back to `last-folder.txt`. |
| `src/main/claude-install.js` | `src/main/claude.js`, `src/main/sessions.js` | `installGuide(platform)` — the per-platform Claude Code setup shell **argv** for the [setup wizard](architecture.md#claude-code-setup-gate): `installArgs()` (POSIX `['-ilc', …]` login-shell installer / Windows `-NoExit -Command`, with the `OK`/`FAIL` markers keyed on the installer's exit status so a failed install is never reported as success) and `authArgs()` (runs `claude` with the PATH-refresh per OS). `claude.js`'s `claudeAvailable()` runs the actual `claude --version` probe and sessions.js wires the `check-claude` IPC. |
| `src/main/usage-parse.js` | `src/main/claude.js`, `src/main/sessions.js` | `parseUsageHeaders` (the unified rate-limit response headers → `{windows, representative}`: both rolling windows, utilization clamped to 0..1, `five_hour`/`seven_day` → `5h`/`7d`, null when the headers are absent), `resetMs` (epoch-seconds or ISO reset value → ms), `formatResetShort` (ms-until-reset → compact `24m`/`13h`/`2d`/`now`, sub-minute rounded up), and `usageView` (the assembled renderer model with reset tokens + bottleneck flag) — the [usage meter](architecture.md#usage-meter). `claude.js`'s `readUsage()` makes the live Messages API call and sessions.js wires the `get-usage` IPC. |
| `src/main/crashlog-lib.js` | `src/main/crashlog.js` | `crashLogName` (sortable, filesystem-safe `crash-<iso>.log` with no `:`/`.`) and `formatCrash` (kind + time + stack, falling back to `String()` when there's no stack) — the [crash log](architecture.md#error-handling--crash-logs) naming/body. crashlog.js owns the fs writes and the global crash-handler wiring. |
| `src/main/hook-events.js` | `src/main/hook-server.js` | `eventToState` (the hook-event → status-dot mapping behind [status detection](status-detection.md), incl. the `git push` → `pushed` command sniff and SessionStart → idle), `shouldApplyState` (a resume's SessionStart → idle must not downgrade an already-meaningful colour), and `hooksSettings(port)` (the `claude --settings` JSON wiring every tracked event to a curl POST). hook-server.js runs the http server, holds the live port, and calls into sessions. |
| `src/renderer/shared/git-status.js` | `src/renderer/git-pane.js` | `statusLabel` — the human-readable tooltip for a status badge, keyed on the staged/unstaged column so the same porcelain letter (notably `D`: staged deletion vs deleted-on-disk-not-staged) reads distinctly and an unstaged deletion is pointed at Discard. |
| `src/renderer/shared/fuzzy.js` | `src/renderer/quick-open.js` | `fuzzyMatch`/`fuzzyFilter` — the Quick Open palette's subsequence matcher: subsequence requirement, consecutive-run / boundary / basename scoring, and the resulting ranking. quick-open.js is the thin DOM/IPC shell around it. |
| `src/renderer/shared/find.js` | `src/renderer/viewer/file.js` | `findMatches` (all non-overlapping hits, case-(in)sensitive), `nearestMatch` (first hit at/after the caret, wrapping), `stepMatch` (next/prev with wraparound) — the file editor's [find-in-file](architecture.md#file-editor) bar. file.js paints the hits into the `.editor-hl` overlay and drives scrolling. |
| `src/renderer/shared/terminal-links-parse.js` | `src/renderer/terminal-links.js` | `findTerminalLinks` (non-overlapping URL-first-then-path spans in one terminal line) and `looksLikePath` (a token is a path if it has a separator, or is a bare filename with a known extension) — the Ctrl+click link detection that deliberately over-matches then filters. terminal-links.js is the xterm/DOM shell: live decorations, hover tracking, and routing a click to the file viewer or inline browser. |
| `src/renderer/shared/ext.js` | — | `extOf` (lowercased extension after the last dot, `''` when none) and `fileColor` (per-extension tree filename colour, `var(--fg)` fallback), plus the `IMG_EXT`/`AUDIO_EXT` asset-viewer sets — the shared file-type helpers used across the tree, file viewer, and terminal links. |
| `src/i18n/index.js` | — | `t()` lookup + English fallback, `setLocale` fallback for unknown codes, `pickLocale` (system-language → locale match on the primary subtag, preference order, English fallback — the first-run auto-detect), and **locale key parity** (every locale has exactly the base `en` key set — catches a string added to `en` but forgotten elsewhere, or an orphan/typo'd key). |

### Renderer/i18n helpers are ES modules

The renderer and `src/i18n/` are loaded by the browser as `<script type="module">`, so they use `import`/`export`. Node treats `.js` as CommonJS by default and would choke on that syntax. A folder-scoped `package.json` (`{"type":"module"}`) marks the testable folders — `src/i18n/` and `src/renderer/shared/` — as ESM so Node's test runner and ESLint can load those pure helpers the way the browser does. The browser ignores the file; the Electron main process never imports renderer/i18n code, so runtime is unaffected. Accordingly tests that import an ESM helper are `.mjs` files (`test/i18n.test.mjs`, `test/git-status.test.mjs`); the tests for the CommonJS main-process helpers are plain `.js` (they `require` the helpers).

## Adding a test

Drop a `*.test.js` (CommonJS, `require` the helper) or `*.test.mjs` (ESM, `import` it) file in `test/`. Use `node:test` + `node:assert/strict`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { thing } = require('../src/main/your-lib');

test('describes the behaviour', () => {
  assert.equal(thing(input), expected);
});
```

If the logic you want to test currently sits inside an `ipcMain.handle(...)` or touches `fs`/`execFile`/the DOM, **first extract the pure part** into a sibling helper (as in the table above), wire the shell to call it, then test the helper.

## Lint

`eslint.config.js` is a flat config with a per-area environment, because the three layers run in different runtimes:

- `src/main/**`, `src/preload/**` → CommonJS, Node globals.
- `src/renderer/**` → ES modules, browser globals (+ the `hljs` CDN global from `index.html`).
- `src/i18n/**` → ES modules, browser globals.
- `test/**` → Node; `*.mjs` is ESM, `*.js` is CommonJS.

Rules are intentionally light — the goal is to catch the failures that otherwise only surface at runtime in the GUI (undefined variables, typos, unused bindings), not to enforce style. `_`-prefixed throwaways (e.g. an `ipcMain` handler's unused `_e`) and empty `catch {}` blocks are allowed.
