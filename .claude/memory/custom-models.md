# Custom models (Ollama)

Lets a user run **local open-source models** from the same New-session dropdown as
the Claude models. Because the whole app is a front-end for the `claude` CLI — and
that CLI speaks **only** the Anthropic Messages API — an Ollama model can't be
driven directly. The feature works by pointing the CLI at a **local proxy** that
translates Anthropic ⇄ Ollama, set per-session via `ANTHROPIC_BASE_URL`.

## The five parts

1. **Translation proxy** — `src/main/ollama-proxy.js`, an in-process `http` server
   on an ephemeral `127.0.0.1` port (mirrors [hook-server.js](architecture.md)).
   It speaks `POST /v1/messages` (streaming SSE + `tool_use`) and forwards to the
   engine's `/api/chat`. All shape-mapping is the pure, unit-tested
   `ollama-translate-lib.js` (`anthropicToOllama`, `ollamaChunkToAnthropicEvents`,
   `ollamaDoneToStopReason`, `nonStreamToAnthropic`); the proxy is only sockets.
2. **Embedded engine** — the Ollama binary is **bundled in the installer**
   (electron-builder `extraResources: vendor/ollama → resources/ollama`), fetched
   by `scripts/fetch-ollama.mjs` into the gitignored `vendor/ollama/<subdir>/`. It
   runs from **`postinstall`** (with `--optional`, so an offline `npm install`
   warns but doesn't abort — retry with `npm run fetch:ollama`) **and** from
   `npm run build*` (without the flag, so packaging fails hard if it can't fetch).
   It's idempotent (skips when the binary is present). The Windows asset is a
   `.zip` extracted with PowerShell `Expand-Archive` (Git Bash's GNU `tar` can't
   read a zip and misparses `C:\`); macOS/Linux assets are `.tgz` via `tar`.
   `src/main/ollama.js` `resolveOllamaBin()` finds it under
   `process.resourcesPath/ollama/<subdir>` (packaged) or `vendor/ollama/<subdir>`
   (dev), falling back to a system `ollama` on PATH. `ensureServe()` runs one
   `ollama serve` with `OLLAMA_MODELS` pointed at `sharedDataDir/ollama/models`
   (via `cleanEnv`) so models live in a dir we control. **Lazy** — nothing starts
   at boot; first pull or first Ollama session spawns it.
3. **Model management** — `src/main/ollama.js` registers the IPC (via
   `remote-bridge`): `ollama-status`/`ollama-ensure` (engine + detected RAM/VRAM),
   `ollama-catalog` (a curated browse list — Ollama has no search API), `ollama-list`
   (installed), `ollama-pull`/`ollama-cancel-pull` (stream progress →
   `ollama-pull-progress`), `ollama-remove`, `ollama-remove-all`. Any change pushes
   `ollama-models-changed`. The renderer section is `src/renderer/custom-models.js`
   (Settings → **Custom models**), styled with the existing settings chrome.
4. **RAM/VRAM fit warning** — `detectSystem()` probes RAM (`os.totalmem()`) + VRAM
   (Windows `Win32_VideoController`, macOS `system_profiler`; Apple Silicon =
   unified memory). The pure `ollama-fit-lib.js` `modelFit(model, sys)` returns
   `ok`/`tight`/`fail`/`unknown`; each catalog/installed row carries `req`
   (`formatReq`) + `fit`. A `fail` shows a red ⚠, `tight` a yellow ⚠, with a native
   `title` tooltip — same look in the New-session caret menu and session badge
   (`src/renderer/sessions.js` `modelFitWarning`). Requirements come from the
   catalog's per-model `minRam`/`minVram` in `ollama-models-lib.js`.
5. **Dropdown merge + routing** — Ollama ids are namespaced **`ollama:<name>`**
   (`ollama-models-lib.js`), so they never collide with `opus`/`sonnet`. The
   renderer caches the installed list (`settings.js` `getOllamaModels` /
   `refreshOllamaModels` / `getMergedModels` / `modelLabel`) and re-renders the
   settings selects, the caret menu, and the session badge off the
   `ollama-models-updated` window event. At spawn, `sessions.js` `ollamaRoute(s)`
   detects an `ollama:` model, calls `ensureRuntime()` (engine + proxy), and merges
   `{ ANTHROPIC_BASE_URL: proxy, ANTHROPIC_API_KEY/AUTH_TOKEN: 'ollama-local',
   ANTHROPIC_MODEL: bareName, CLAUDE_CODE_SUBAGENT_MODEL: bareName }` over
   `sessionEnv(s)`. Kept in the shell, not the pure `agent-models.js`.

## Live model switch across the boundary

A live `/model <id>` **cannot** cross Claude↔Ollama: the base-url/auth env only
changes on a respawn. `sessions.js` `set-session-model` detects a boundary crossing
(`isOllamaId(old) !== isOllamaId(new)`) and **respawns** the PTY (`claude --resume`,
so the conversation continues) instead of typing `/model`; the dying PTY's `onExit`
skips teardown while `s.respawning` is set (same idea as `s.suspended`). Same-family
switches keep the fast in-place `/model` path.

## Lifecycle / cleanup (no leaks)

`index.js`'s `window-all-closed` **and** `before-quit` call `stopOllamaRuntime()` →
`ollama.stopOllama()` (kills serve **and its runner children** — Windows
`taskkill /T /F`, POSIX kills the process group) + `ollama-proxy.stopProxyServer()`.
**Uninstall:** Windows NSIS (`build/uninstall-ollama.nsh`, wired via `nsis.include`)
kills `ollama.exe` and `RMDir /r`s `%APPDATA%\Claude Session Editor\ollama` — only
the ollama subdir, so `deleteAppDataOnUninstall` stays false. macOS has no
uninstaller hook, so **Remove all Ollama data** (`ollama-remove-all`) is the
supported reclaim path (also the general reset).

## Mobile (selection only)

A paired phone can **pick** an installed Ollama model but not manage them. Enforced
at the `server/protocol.js` allowlist: only `ollama-list` (req) +
`ollama-models-changed` (event) are exposed; the management channels are absent.
`mobile/src/api/models.ts` + `SessionsScreen.tsx` fetch `ollama-list`, show the
models under an "Ollama" divider in the split-button menu, and refresh on the push.
The `model` rides the existing `new-session` req; main routes/respawns identically
regardless of origin.

## Pure libs (tested)

`ollama-translate-lib.js`, `ollama-models-lib.js`, `ollama-fit-lib.js`,
`ollama-bin-lib.js` — see [testing.md](testing.md). The shells (`ollama.js`,
`ollama-proxy.js`) stay thin per the testability rule.
