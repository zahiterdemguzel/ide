# Language servers (LSP)

The Monaco editor gets IDE-grade intelligence (completion, hover, go-to, references, rename, code actions, formatting, diagnostics, semantic tokens, inlay hints, …) from real language servers over the Language Server Protocol. Monaco 0.57's own `monaco.lsp.MonacoLspClient` is not used (single server, lowercases URIs, throws on locations in unopened files, no per-language selector); we have our own client.

Split: **main is a dumb pipe, the renderer speaks the protocol.**

## Files

| File | Role |
|---|---|
| `src/main/lsp-lib.js` | Pure, tested (`test/lsp-lib.test.mjs`). Content-Length framing (`encodeMessage`, `createMessageReader` — yields raw body strings), the **server registry** `SERVERS`, `resolveLaunch(languageId, ctx)` (injected `which`/`bundled`/`exists`), PATH search (`extraSearchDirs`, `searchDirs`, `findExecutable`, login-shell PATH parse), `serverEnv`, `spawnInvocation`, `unpackedPath`, `findVenvPython`, `serverSettings`. |
| `src/main/lsp.js` | The host: one process (or socket) per `(serverId, root)`, forwards frames both ways, logs stderr (bounded, 64 KB/server), reports exits. Never parses a message body. `stopAllLanguageServers()` is called from index.js's quit path. |
| `src/preload/lsp.js` | `lspEnsure`, `lspSend` (fire-and-forget `ipcRenderer.send`, so ordering is preserved), `lspStop`, `lspStopAll`, `onLspMessage`, `onLspExit`. |
| `src/renderer/editor/lsp-convert.js` | Pure, tested (`test/lsp-convert.test.mjs`). LSP ⇄ Monaco shapes with Monaco enums mirrored as numeric tables, URI normalization, WorkspaceEdit flattening, config section lookup, dynamic-registration merge. No `monaco` import. |
| `src/renderer/editor/lsp-client.js` | The client: initialize handshake, document sync, per-language Monaco providers from server capabilities, diagnostics store, server→client requests. The only LSP file that touches `monaco`. |

## IPC

- `lsp-ensure {languageId, root}` → `{ok, key, serverId, name, languages, settings, initializationOptions?, reused}` or `{ok:false, reason, unknown}` (`unknown`: no server exists for that language — the client reports no status for it).
- `lsp-send {key, message}` (`ipcMain.on`; message is a JSON string).
- `lsp-stop {key}`, `lsp-stop-all`.
- Pushes: `lsp-message {key, message}` (JSON string), `lsp-exit {key, code, signal, error}` (not sent for a stop the renderer asked for).

`lsp-stop` unregisters the key immediately (a new ensure gets a fresh server) and kills the process after 1.5 s if `exit` didn't end it. The client sends `shutdown` (with **no** `params` — TS 7's server rejects `"params": null`) → `exit` → `lsp-stop`. On init the client calls `lsp-stop-all`, because a renderer reload loses client state while main keeps servers alive, and a server can't be initialized twice.

## Server registry — adding a server

One row in `SERVERS` (lsp-lib.js): `id`, `name`, Monaco `languages`, `launch` candidates tried in order, optional `install` hint / `unavailable` message. Launch kinds: `{bundledScript}` (Node script in node_modules, run with the Electron binary + `ELECTRON_RUN_AS_NODE=1`), `{bundledBinary: (platform, arch) => relPath}`, `{command, args, platforms?}` (found on PATH), `{tcp: {host, port}}`. A language must appear in only one row (a test enforces it). If Monaco has no language id for the files, the editor host must register one. Server-specific settings go in `serverSettings`; LSP languageIds that differ from Monaco's (tsx → `typescriptreact`, shell → `shellscript`) go in `lspLanguageId` (lsp-convert.js).

Registered: pyright (python, bundled), TypeScript (typescript/javascript, bundled), gopls, rust-analyzer, clangd (c/cpp/objective-c, also `xcrun clangd`), sourcekit-lsp (also `xcrun`), csharp-ls / OmniSharp, jdtls (gets `-data <userData>/lsp-cache/jdtls/<hash>`), lua-language-server, ruby-lsp / solargraph, intelephense, kotlin-language-server, bash-language-server, yaml-language-server, dart, zls, elixir-ls, haskell-language-server-wrapper, metals, docker-langserver, terraform-ls, and Godot (gdscript over TCP 127.0.0.1:6005 — only while the project is open in the Godot editor; otherwise `unavailable` with that message).

## Bundled servers & packaging

- **Pyright**: `node_modules/pyright/langserver.index.js --stdio` under `process.execPath` + `ELECTRON_RUN_AS_NODE=1`.
- **TypeScript**: the `typescript` dependency is **TS 7, the native Go compiler**. It ships no `tsserver.js` (so typescript-language-server can't use it) but its binary has a built-in LSP: `node_modules/@typescript/typescript-<platform>-<arch>/lib/tsc --lsp --stdio`. That's the primary JS/TS server. `typescript-language-server` (bundled) is only a fallback when the native binary is missing, and needs a pre-7 `tsserver.js` in the project's `node_modules` (path passed as `initializationOptions.tsserver.path`). Note typescript-language-server 6 declares Node ≥ 22; Electron 31 runs Node 20.
- Packaged builds: a child can't exec/require from inside `app.asar`, so `build.asarUnpack` lists `pyright`, `typescript`, `@typescript` (the native binary), `typescript-language-server`. The host resolves `app.getAppPath()/node_modules/...` and rewrites `app.asar/` → `app.asar.unpacked/` (`unpackedPath`). The native TS package is a per-platform optional dependency, so each CI OS packages its own.

## Finding PATH servers

A Finder/Dock-launched macOS app inherits launchd's minimal PATH. The host searches the inherited PATH, then the **login-shell PATH** (`$SHELL -ilc` printing PATH between markers, run once, 5 s timeout, only when a non-bundled server is needed), then `extraSearchDirs` (~/go/bin, ~/.cargo/bin, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, npm/volta/bun/dotnet/ghcup/coursier/rbenv/asdf dirs; Windows: %APPDATA%\npm, scoop shims, …). The merged PATH is also the server's own PATH (gopls needs `go`). Windows `.cmd`/`.bat` servers go through the shell (Node refuses to spawn them directly).

## Client behavior (lsp-client.js)

- **Lazy start**: a server starts the first time a model of one of its languages is tracked (`lspTrackModel`). A language binds to at most one connection; a connection may serve several languages. Results (failures too) are cached per language until `lspRestart` or a root switch.
- **Root**: `host.getRoot()` (falls back to the file's directory when null). On a change (checked on every `lspTrackModel` and on `folder-changed`) all servers stop and every still-tracked model re-attaches to fresh ones. A `rootGeneration` counter drops late results from the old root.
- **Sync**: didOpen / didChange (incremental when the server supports it — Monaco's `e.changes` are already ordered for sequential application — else full) / didSave (if the server asked) / didClose on dispose; language change = close + reopen. Sent synchronously so a didChange always precedes later requests. URIs sent to servers come from `pathToUri(model.uri.fsPath)` (drive letter unencoded: `file:///c:/x`).
- **Providers** are registered per languageId from the effective capabilities (static + `client/registerCapability`; re-registered on every (un)registration): completion (+resolve, snippets, itemDefaults, insert/replace ranges), hover, signatureHelp, definition/declaration/typeDefinition/implementation, references, documentHighlight, documentSymbol, rename (+prepareRename), codeAction (+resolve; edits and server commands), formatting/rangeFormatting/onTypeFormatting, inlayHints (+resolve), foldingRange, selectionRange, documentLink (+resolve), codeLens (+resolve), semantic tokens (full, delta, range). A provider only answers for models that server has open, so diff/inmemory models of the same language get nothing.
- **Cross-file results**: every location / workspace-edit URI is mapped back to an existing model via `normalizeUri`, else `host.ensureModel(monaco.Uri.file(path))` loads it first — Monaco's peek/navigation/rename need a model for every location.
- **Commands**: server commands become the Monaco command `lsp.executeServerCommand` → `workspace/executeCommand`; Monaco's own `editor.*` commands pass through (`editor.action.showReferences` args are converted, loading models first).
- **Diagnostics**: `publishDiagnostics` and pull diagnostics (`textDocument/diagnostic`, 250 ms after a change; `workspace/diagnostic/refresh` re-pulls) feed one store keyed by normalized URI and owner `lsp-<serverId>`. Markers go to the model if there is one (and are applied when one appears later); `getAllDiagnostics()` includes files without models. Listeners are notified coalesced (50 ms).
- **Server→client requests**: `workspace/configuration` (from main's `serverSettings` — pyright: `python.analysis` defaults + `python.pythonPath` from a `.venv`/`venv`/`env` in the root; TS: inlay-hint prefs), `workspace/workspaceFolders`, register/unregisterCapability, `window/workDoneProgress/create`, `showMessageRequest` (→ null), `showDocument` (→ unsupported), `workspace/applyEdit` (applied via `pushEditOperations`, one undo step per file), and the semanticTokens/codeLens/inlayHint/diagnostic refresh requests.
- **Cancellation**: Monaco's token → `$/cancelRequest` and the provider resolves null. ContentModified/RequestCancelled errors are not logged.
- **Crashes**: a server that dies after becoming ready restarts automatically (re-attaching its models) up to 3 times in 3 min, then status `error`. A server that dies during startup is reported as `error` and stays down until `lspRestart`.

## Gotchas

- **Monaco's built-in TS worker**: 0.57 registers its JS/TS providers once, when the language first activates, from `modeConfiguration` — later `setModeConfiguration` calls are ignored. So `initLsp` switches the worker's providers off up front (must run before the first JS/TS model is created). Only its diagnostics are toggleable later: they stay on until the TS server is ready and come back if it stops. The defaults live at `monaco.typescript` in 0.57 (`monaco.languages.typescript` is a deprecated stub); the client checks both.
- Semantic tokens only show if the editor has `'semanticHighlighting.enabled': true` and the theme has rules for the token types.
- Pyright doesn't advertise inlay hints, semantic tokens or formatting; TS 7 uses **pull** diagnostics only (no publishDiagnostics).
- Create/rename/delete-file operations in workspace edits are not applied (the client advertises `resourceOperations: []`; they're logged).
- `workspace/didChangeWatchedFiles` is not implemented: files changed outside the editor aren't reported to servers (pyright/tsgo watch the disk themselves in most setups).
