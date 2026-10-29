# Editor AI assist (Cursor-style)

Ghost-text completions, Cmd/Ctrl+K inline edits with a reviewable inline diff, "add to Claude session" mentions, and AI quick fixes for diagnostics, all in the Monaco editor. Model calls go straight to the Messages API with the Claude Code OAuth token (no `claude` process per keystroke).

## Files

| File | Role |
|---|---|
| `src/main/ai-assist-lib.js` | Pure: prompts, output cleaners, model order + per-model request extras, rejection test. Tested in `test/ai-assist-lib.test.mjs`. |
| `src/main/ai-assist.js` | `completeCode` / `editCode` (plain-node callable), model fallback + memo, token cache, in-flight abort map, IPC registration (only when running in Electron main: `process.type === 'browser'`). |
| `src/main/claude.js` | `callMessages({ model, system, messages, maxTokens, stopSequences, stream, onText, signal, extra, token })`: the general OAuth Messages call. The CC identity is always the first system block. SSE streaming + AbortSignal. Never rejects: `{ok:true,text,stopReason}` / `{ok:false,status,errorType,message,aborted?}`. `runCli(prompt, {model, systemPrompt, signal})` is the lean CLI fallback (`leanArgs()`). `runHaiku` behaves as before. |
| `src/preload/ai.js` | `aiComplete`, `aiEdit`, `aiCancel(id)`, `aiStatus`, `onAiEditChunk(cb)` → unsubscribe. |
| `src/renderer/editor/ai.js` | Monaco side. Exports `initAi(monaco, host)`, `attachAiToEditor(editor)`, `aiStatus()`, `onAiStatus(cb)`. |
| `src/styles/ai.css` | Prompt widget + inline diff styles (theme variables only). |

`host` = `{ getRepoPath, relPath(model), isInlineEnabled(), sendToSession(text), askInNewSession(text) }`.

## IPC

- `ai-complete {id, language, path, prefix, suffix, snippets?}` → `{text, model, ms, error?, aborted?, skipped?}` (`text` is `''` when there is nothing to show).
- `ai-edit {id, language, path, instruction, selection, prefix, suffix, previous?, baseIndent?}` → `{ok:true, text, model}` / `{ok:false, error, aborted?}`. While it streams, main sends `ai-edit-chunk {id, text}` (raw text deltas) to the **requesting webContents only** (`event.sender`, not `sendToRenderer`, so nothing goes to remote clients). `baseIndent`: omitted = the selection's common indent, `null` = keep the model's indent.
- `ai-cancel {id}` aborts the request (HTTP request destroyed, or CLI child killed).
- `ai-status` → `{tokenPresent, lastCallOk, models:{complete, edit}}`.

## Models + fallback

- Completions: `claude-haiku-5-5`, then `claude-haiku-4-5-20251001`. Edits: `claude-sonnet-5-5`, then `claude-sonnet-4-5`, then Haiku 4.5. The first id that works is memoised per role. Only a 400/404 moves on to the next model; 401/429/network/abort are returned as they are. A 401 also drops the cached token.
- The 5.5 models think by default, which only adds latency here. Haiku 5.5 gets `thinking:{type:'disabled'}`. Sonnet 5.5 rejects `disabled`, so it gets `thinking:{type:'between_tools'}` (no tools, so in effect no thinking). Don't send `temperature`: the 5.5 models reject non-default sampling. Don't prefill the assistant turn either: the 4.6+ models return a 400.
- With this account's OAuth token (checked 2026-10), `claude-sonnet-4-5` returns 404, so the edit fallback goes straight to Haiku.
- No token: completions return `''` (`error:'no_token'`). Edits fall back to `claude -p --model sonnet` with lean args. That path doesn't stream (it sends one chunk at the end) and it also refreshes the token. The CLI system prompt must not contain `"` (Windows argv quoting).
- `readOauthToken` runs the macOS Keychain lookup synchronously, so `ai-assist.js` caches the token for 2 minutes.

## Prompts

- Completion is fill-in-the-middle: the prefix (last ~4000 chars) + `<|CURSOR|>` + the suffix (next ~2000), both cut at line boundaries, plus up to 4 optional `snippets`. The model answers inside `<fill>…</fill>` and the stop sequence is `</fill>`. `max_tokens` is 256.
- Edit: the selection goes in `<selection>` between `<before_selection>` (about 6000 chars) and `<after_selection>` (about 3000). Generating at the cursor uses a `<|CURSOR|>` file excerpt instead. A follow-up adds the current `<proposal>` and asks for a revision. The answer comes inside `<replacement>…</replacement>`.
- Cleaners: unwrap the tag (the closing tag is usually eaten by the stop sequence), strip ``` fences and "Here is…:" preambles, and return `''`/`null` for refusals. Completions also: drop a repeat of the typed line or indent; drop a tail that duplicates the start of the suffix (short overlaps only when that fixes bracket balance, so `foo()` before `)` survives); stay single-line when text follows the cursor on the same line; cap at 12 lines, cutting at a blank line. Edits also: drop leading blank lines and trailing whitespace, and re-indent the block to `baseIndent`. `cleanEdit` returns `''` for a deliberate empty replacement (the model used the tag) and `null` for junk.

## Renderer features + keybindings

- **Ghost text**: one `registerInlineCompletionsProvider('*', …)` with `debounceDelayMs: 300` (Monaco does the debounce). Monaco's cancellation token triggers `ai-cancel`. An LRU (40 entries) is keyed by uri + the last 500 prefix chars + the first 100 suffix chars. The `inlineCompletions` editor setting is **off by default** (each suggestion is an API call on the user's tokens), so ghost text only runs once the user turns it on. It is skipped when `host.isInlineEnabled()` is false, when the suggest widget is open, for files over 500k chars, in read-only editors, mid-identifier, and while an inline edit is open on that model. Tab accepts and Cmd/Ctrl+Right accepts the next word (Monaco defaults). `attachAiToEditor` turns `inlineSuggest.enabled` on.
- **Cmd/Ctrl+K** (`claude.ai.inlineEdit`, context menu "Edit with AI…"):
  - The prompt is an overlay widget pinned to a view zone (via `onDomNodeTop`), so it pushes code down instead of covering it.
  - The target is always whole lines. With a selection, those lines are rewritten. On a blank cursor line, code is generated into that line. On a non-blank line, new lines are generated below it.
  - Enter submits, Esc cancels or closes, and a streamed line count shows progress.
  - The result is applied as **one** `executeEdits` between undo stops. The new lines get a green whole-line decoration (`ai-diff-inserted-line`). The original text appears in a red, struck-through view zone above them (`ordinal` 2, below the prompt's 1), in the editor font.
  - Review: Accept is Cmd/Ctrl+Enter or the button. Reject is Esc or the button, and puts the original back exactly as one undoable edit (or deletes the inserted lines). Typing another instruction refines the current proposal, which is replaced in place while the red zone keeps the original.
  - The proposal's current position comes from the decoration range, so edits the user makes elsewhere don't break it. Switching models (files) closes the session and keeps what was applied.
- **Cmd/Ctrl+L** (`claude.ai.addSelectionToSession`): `host.sendToSession('@rel#L3-9 ')` (`#L3` for one line, `@rel ` with no selection). A selection that ends at column 1 doesn't include that line.
- **Context menu** (group `1_claude`): Add Selection to Claude Session · Explain with Claude (`askInNewSession` with the localized `ai.explainPrompt`) · Edit with AI… · Generate Doc Comment (a preset inline edit that runs immediately; with no selection it rewrites the cursor line).
- **Quick fixes**: a `registerCodeActionProvider('*')` for warning/error markers (`context.markers`, falling back to `getModelMarkers({resource})` filtered to the range). "Fix with AI" selects the marker's lines and runs an inline edit with `Fix: <message>`. "Ask Claude Session to Fix" sends `ai.askFixPrompt` with the @mention. The commands are registered globally with `monaco.editor.registerCommand` (`claude.ai.fixDiagnostic`, `claude.ai.askSessionToFixDiagnostic`).
- **Status**: `aiStatus()` = `{available: tokenPresent && lastCallOk !== false, busy: an inline edit is in flight}`. Completions don't set `busy`, so the status bar doesn't flicker on every keystroke. `onAiStatus(cb)` returns an unsubscribe.

## Gotchas

- Cmd/Ctrl+K and Cmd/Ctrl+L **override** Monaco defaults, as in Cursor: the Cmd+K chord family (Cmd+K Cmd+C comment, Cmd+K Cmd+0 fold…) and "expand line selection". Monaco's keybinding resolver lets the last-registered matching binding win, and `addAction` bindings register after the defaults.
- The widget's root stops `keydown`/`mousedown` propagation, so the editor's and the app's keybindings never see keys typed into the prompt. While a request runs the input is `readOnly`, not `disabled`, because a disabled input drops focus and Esc couldn't cancel.
- The editor-level Esc binding only fires when `claudeAiInlineEditActive && !suggestWidgetVisible && !findWidgetVisible && !inlineSuggestionVisible`, so it doesn't steal Esc from those widgets.
- Monaco normalises `\n` to the model's EOL on every edit, so the renderer reads text with `EndOfLinePreference.LF` and writes `\n`.
- Inline completion text that contains a newline is only offered when nothing but whitespace follows the cursor on that line (Monaco requires a multi-line insert to end at the end of a line).
