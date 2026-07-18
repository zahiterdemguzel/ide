# Custom models (local, via node-llama-cpp)

Lets a user run **local open-source models** from the same New-session dropdown as
the Claude models. Because the whole app is a front-end for the `claude` CLI — and
that CLI speaks **only** the Anthropic Messages API — a local model can't be driven
directly. The feature works by pointing the CLI at a **local proxy** that translates
Anthropic ⇄ the model, set per-session via `ANTHROPIC_BASE_URL`.

> **Naming note.** The engine is [node-llama-cpp](https://node-llama-cpp.withcat.ai)
> (in-process GGUF inference), **not** Ollama. The `ollama:` model-id prefix, the
> `ollama-*` IPC channel names, the `ollama-*-lib.js` files, and the "Ollama" UI
> labels are kept as historical names so saved sessions and the phone bridge don't
> break — they're just names now. It used to embed an `ollama serve` sidecar; that
> was replaced (no external binary to download at install/build time, no child
> process). If you see "Ollama" in code/UI, read "the local model engine."

## The parts

1. **Translation proxy** — `src/main/ollama-proxy.js`, an in-process `http` server on
   an ephemeral `127.0.0.1` port (mirrors [hook-server.js](architecture.md)). It
   speaks `POST /v1/messages` (streaming SSE + `tool_use`) and calls the in-process
   engine directly (no upstream HTTP). All shape-mapping is the pure, unit-tested
   `ollama-translate-lib.js` (`anthropicToOllama`, `ollamaChunkToAnthropicEvents`,
   `ollamaDoneToStopReason`, `nonStreamToAnthropic`); the engine emits the same
   **Ollama `/api/chat` chunk shape** those functions already consume, so the
   translation is unchanged. An `AbortController` tied to `res` close cancels a
   running generation if the CLI hangs up mid-turn. The streaming path **defers the
   `200`/event-stream header until the first chunk arrives**, so a failure *before*
   any output (e.g. the model isn't installed) is returned as a normal non-200 JSON
   error the CLI can display — not a 200 stream with only an error event, which the
   CLI reports as "empty or malformed response".
2. **Engine** — `src/main/llama-engine.js` wraps **node-llama-cpp** (an npm dep that
   ships its own prebuilt llama.cpp binaries; no app-specific download). It's ESM +
   main-process only, so it's loaded lazily via dynamic `import()` from this CommonJS
   module and cached. `getLlama()` once; a loaded model is kept in an **LRU-of-1**
   cache (loading a GGUF is the expensive step) with a per-engine generation **mutex**
   (one context sequence can't run two generations at once). `chat(ollamaBody,
   {onChunk, signal})` runs ONE **stateless** turn via the low-level `LlamaChat`
   class's `generateResponse(history, {functions, onTextChunk})`, which **returns**
   function calls without executing them — the CLI executes tools itself and re-sends
   the full history each request, so we rebuild history from scratch every call and
   never run handlers. Models live under `sharedDataDir/llama/models/<name>.gguf`.
   All the fiddly pure shaping is `llama-engine-lib.js` (`buildHistory` folds each
   `{role:'tool'}` result back into its assistant turn; `buildFunctions`,
   `buildGenOptions`, `toToolCalls`, `doneReason`).

   **Context size is sized to the actual prompt, not auto and not fixed.** Measured
   with the real CLI, Claude Code's prompt is **~29k tokens** (system prompt + every
   tool/MCP schema) and grows past **39k** once tool results come back — far bigger
   than a guessed fixed size, and node-llama-cpp's default auto-sizes to *available
   VRAM* (a tiny context on a busy GPU). Either way the prompt overflows and
   `generateResponse` throws "context shift strategy did not return a history that
   fits" → the CLI shows an empty/502 reply. So each `chat()` **tokenizes the incoming
   prompt** (`estimatePromptTokens`) and `ensureContext` (re)creates a context sized to
   it (`desiredContextSize`: prompt + reserve, ×1.15, clamped `CTX_MIN` 8192 …
   `CTX_MAX` 65536, preferring not to exceed the model's train context unless the
   prompt truly needs it). GPU first (`flashAttention` shrinks the KV cache); if that
   size won't fit VRAM it reloads on `gpuLayers: 0` (CPU/system RAM), which always has
   room — slower, correct. The context grows across turns as the prompt grows (so a
   long agent loop may migrate GPU→CPU). If the prompt exceeds `CTX_MAX`, `chat()`
   throws a clear "disable some MCP servers/tools" error instead of a cryptic 502.
   Don't revert this to a fixed `createContext({contextSize})`.

   **Weak models: tool calls printed as text are salvaged.** Small models (1.5–3B)
   often can't emit the native tool-call tokens and instead print `{"name":…,
   "arguments":…}` as text — either the whole reply, or **buried in prose** ("Here's
   how you can use the Glob tool: {…}") — so the CLI never executes the tool. When the
   native parser returns no calls but tools were offered, `salvageToolCall` scans the
   reply (whole reply, ```json fences, `<tool_call>` wrappers, and any bare balanced
   `{…}` object) for the first JSON object naming a **known** tool and converts it into
   a real `tool_use`; a pure-call reply is also withheld from the stream
   (`looksLikeToolCallStart` → `mode='hold'`) so the raw JSON isn't shown, while a
   prose-wrapped call keeps the prose and just appends the `tool_use`. Both helpers are
   pure + tested in `llama-engine-lib.js`. Verified end-to-end against the real `claude`
   CLI (salvaged `Read`/`Glob` calls executed and their results came back on the next
   turn). Bigger tool-capable models (Qwen2.5-Coder-7B+) emit native calls and are far
   more reliable; catalog models all have a 32k+ context.
3. **Model management** — `src/main/ollama.js` is the thin IPC shell (via
   `remote-bridge`), delegating to the engine: `ollama-status`/`ollama-ensure`
   (starts the proxy + reports detected RAM/VRAM), `ollama-catalog` (a curated browse
   list), `ollama-list` (installed GGUFs), `ollama-pull`/`ollama-cancel-pull` (stream
   download progress → `ollama-pull-progress`), `ollama-remove`, `ollama-remove-all`.
   Any change pushes `ollama-models-changed`. The renderer section is
   `src/renderer/custom-models.js` (Settings → **Local models**). Pulls resolve a
   catalog `name` (or a raw `hf:`/URL a user pastes) to a `{source, name}` via
   `resolvePullTarget`; the engine downloads with node-llama-cpp's
   `createModelDownloader` and reports the same `{phase, pct, done, error}` shape (run
   through the unchanged `parsePullProgress`).
4. **RAM/VRAM fit warning** — `llama-engine.js` `detectSystem()` probes RAM
   (`os.totalmem()`) + VRAM (node-llama-cpp `llama.getVramState()`; a non-zero
   `unifiedSize` marks Apple-Silicon unified memory). The pure `ollama-fit-lib.js`
   `modelFit(model, sys)` returns `ok`/`tight`/`fail`/`unknown`; each catalog/installed
   row carries `req` (`formatReq`) + `fit`. A `fail` shows a red ⚠, `tight` a yellow ⚠,
   same look in the New-session caret menu and session badge (`src/renderer/sessions.js`
   `modelFitWarning`). Requirements come from the catalog's per-model `minRam`/`minVram`
   in `ollama-models-lib.js`.
5. **Dropdown merge + routing** — local ids are namespaced **`ollama:<name>`**
   (`ollama-models-lib.js`), so they never collide with `opus`/`sonnet`. The renderer
   caches the installed list (`settings.js` `getOllamaModels` / `refreshOllamaModels` /
   `getMergedModels` / `modelLabel`) and re-renders the settings selects, the caret
   menu, and the session badge off the `ollama-models-updated` window event. At spawn,
   `sessions.js` `ollamaRoute(s)` detects an `ollama:` model, calls `ensureRuntime()`
   (starts the proxy), and merges `{ ANTHROPIC_BASE_URL: proxy, ANTHROPIC_API_KEY/
   AUTH_TOKEN: 'ollama-local', ANTHROPIC_MODEL: bareName, CLAUDE_CODE_SUBAGENT_MODEL:
   bareName }` over `sessionEnv(s)`. The bare `<name>` maps to `<name>.gguf` on disk.

## Live model switch across the boundary

A live `/model <id>` **cannot** cross Claude↔local: the base-url/auth env only changes
on a respawn. `sessions.js` `set-session-model` detects a boundary crossing
(`isOllamaId(old) !== isOllamaId(new)`) and **respawns** the PTY (`claude --resume`, so
the conversation continues) instead of typing `/model`; the dying PTY's `onExit` skips
teardown while `s.respawning` is set. Same-family switches keep the fast in-place path.

## Lifecycle / cleanup (no leaks)

`index.js`'s `window-all-closed` **and** `before-quit` call `stopOllamaRuntime()` →
`ollama.stopOllama()` (→ engine `stop()`: cancels in-flight downloads, disposes the
loaded model + context) + `ollama-proxy.stopProxyServer()`. There's no external process
to kill anymore. **Uninstall:** there is no installer/uninstaller on any platform
(Windows ships as `win-unpacked`), so **Remove all local model data**
(`ollama-remove-all`) is the only supported way to reclaim
`%APPDATA%\Claude Session Editor\llama`.

## Build / install

No download step: `node-llama-cpp` is a normal dependency whose own install pulls the
prebuilt binaries (platform packages under `node_modules/@node-llama-cpp/*`). electron-
builder asar-packs `node_modules`, so the native addons must be **`asarUnpack`**'d
(`node_modules/node-llama-cpp/**`, `node_modules/@node-llama-cpp/**`) — they can't load
from inside an asar. `npmRebuild` stays false. The old `scripts/fetch-ollama.mjs`,
`vendor/ollama` `extraResources`, and `ollama-bin-lib.js` are gone.

## Mobile (selection only)

A paired phone can **pick** an installed local model but not manage them. Enforced at
the `server/protocol.js` allowlist: only `ollama-list` (req) + `ollama-models-changed`
(event) are exposed; the management channels are absent. `mobile/src/api/models.ts` +
`SessionsScreen.tsx` fetch `ollama-list`, show the models under an "Ollama" divider in
the split-button menu, and refresh on the push. The `model` rides the existing
`new-session` req; main routes/respawns identically regardless of origin.

## Pure libs (tested)

`ollama-translate-lib.js`, `ollama-models-lib.js`, `ollama-fit-lib.js`,
`llama-engine-lib.js` — see [testing.md](testing.md). The shells (`ollama.js`,
`ollama-proxy.js`, `llama-engine.js`) stay thin per the testability rule.
