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
| `src/main/git-parse.js` | `src/main/git.js` | `parsePorcelain` (staged/unstaged/conflicts split, rename arrows, unmerged states, non-ASCII paths) and `parseLog` (unit-separator field splitting). git.js runs the subprocess and feeds stdout here. |
| `src/main/recent-folders.js` | `src/main/repo.js` | `addRecent` — front-insert + dedup + cap for the Open-folder recent-projects list (the reverse-combobox). repo.js handles the file persistence and IPC. |
| `src/i18n/index.js` | — | `t()` lookup + English fallback, `setLocale` fallback for unknown codes, and **locale key parity** (every locale has exactly the base `en` key set — catches a string added to `en` but forgotten elsewhere, or an orphan/typo'd key). |

### i18n is ES modules

The renderer and `src/i18n/` are loaded by the browser as `<script type="module">`, so they use `import`/`export`. Node treats `.js` as CommonJS by default and would choke on that syntax. `src/i18n/package.json` (`{"type":"module"}`) marks just that folder as ESM so Node's test runner and ESLint can load the engine and locale files the way the browser does. The browser ignores the file; the Electron main process never imports i18n, so runtime is unaffected. Accordingly `test/i18n.test.mjs` is an `.mjs` file (it `import`s the engine); the other test files are CommonJS `.js` (they `require` the helpers).

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
