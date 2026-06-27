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
| `src/renderer/shared/git-status.js` | `src/renderer/git-pane.js` | `statusLabel` — the human-readable tooltip for a status badge, keyed on the staged/unstaged column so the same porcelain letter (notably `D`: staged deletion vs deleted-on-disk-not-staged) reads distinctly and an unstaged deletion is pointed at Discard. |
| `src/renderer/shared/fuzzy.js` | `src/renderer/quick-open.js` | `fuzzyMatch`/`fuzzyFilter` — the Quick Open palette's subsequence matcher: subsequence requirement, consecutive-run / boundary / basename scoring, and the resulting ranking. quick-open.js is the thin DOM/IPC shell around it. |
| `src/renderer/shared/find.js` | `src/renderer/viewer/file.js` | `findMatches` (all non-overlapping hits, case-(in)sensitive), `nearestMatch` (first hit at/after the caret, wrapping), `stepMatch` (next/prev with wraparound) — the file editor's [find-in-file](architecture.md#file-editor) bar. file.js paints the hits into the `.editor-hl` overlay and drives scrolling. |
| `src/i18n/index.js` | — | `t()` lookup + English fallback, `setLocale` fallback for unknown codes, and **locale key parity** (every locale has exactly the base `en` key set — catches a string added to `en` but forgotten elsewhere, or an orphan/typo'd key). |

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
