# Code editor (Monaco)

Opening a text file shows it in a **Monaco** editor (the editor component of VS Code), wrapped in VS Code-style chrome: preview/pinned **tabs**, **breadcrumbs**, a **status bar**, git **change markers** and **inline blame**, **debugger** breakpoints and value hovers, **language-server** intelligence ([lsp.md](lsp.md)) and **AI** assistance ([ai-assist.md](ai-assist.md)). The host is `src/renderer/viewer/file.js`; everything else lives in `src/renderer/editor/`.

## Files

| File | Role |
|---|---|
| `viewer/file.js` | The host. Creates the one editor, owns tab state, wires every module below. Public API: `showFile(file, jump, {preview})`, `getActiveFile`, `getEditorContext`, `saveActiveFile`, `saveAllFiles`, `closeFile`, `renameOpenFile`, `onEditorRepoChanged(root)`, `getEditorSettings`/`setEditorSettings`. |
| `editor/monaco-loader.js` | Loads Monaco's prebuilt AMD build from `node_modules/monaco-editor/min/vs` (no bundler), on first use or when the app goes idle. |
| `editor/theme.js` | Builds the `ide` Monaco theme from the app's CSS variables and rebuilds it when `html[data-theme]` changes. Also holds the semantic-token colours (Dark+/Light+). |
| `editor/gdscript-lang.js` | A Monarch tokenizer and language config for GDScript (Monaco has none). |
| `editor/languages.js` *(pure)* | file name → Monaco language id (Godot/shader/config extensions Monaco doesn't know). |
| `editor/documents.js` | One Monaco model per open file: load, dirty tracking, save, disk sync, conflicts, rename. |
| `editor/tabs-model.js` *(pure)* | Tab state transitions (preview tabs, MRU, reorder, rename, background tabs). |
| `editor/tabs.js` | The tab strip DOM (`#editor-tabs`): click, middle-click, double-click to pin, drag to reorder, context menu. |
| `editor/gutter.js` | Margin decorations: breakpoints and the paused line, git change bars against HEAD, inline blame. |
| `editor/line-diff.js` *(pure)* | `lineChanges(base, current)`: a Myers line diff → added/modified/deleted ranges for the git bars. |
| `editor/status-bar.js` | `#editor-status`: problems, Ln/Col and selection, indentation, EOL, encoding, language, LSP state, AI toggle. |
| `editor/breadcrumbs.js` | Renders the folder › file › symbol trail into `#diff-file` (symbols come from LSP `documentSymbol`). |
| `editor/symbol-path.js` *(pure)* | `symbolPathAt` (the symbols around the caret) and `relativeTime` (for blame). |
| `editor/symbol-picker.js` | The Quick Open-style picker for Go to Symbol in Workspace (Cmd/Ctrl+T), plus `quickPick` for the language and indentation pickers. |
| `editor/problems.js` | The Problems popover that opens from the status bar. |
| `editor/markdown-preview.js` | The Markdown Preview (marked; raw HTML is escaped). |
| `editor/editor-settings.js` *(pure)* | Settings → Editor: defaults, validation, and the mapping to Monaco options. |
| `editor/settings-section.js` | Builds the Settings dialog's Editor group from a field table. |
| `styles/editor.css` | All the editor's chrome styles. |

## Loading Monaco

- **Loading.** `loadMonaco()` injects `editor.main.css` and `loader.js`, points `require.config({paths:{vs}})` at `node_modules`, and requires `vs/editor/editor.main`. Monaco's own `MonacoEnvironment` creates the language workers from blob URLs; the CSP allows `worker-src blob:`.
- **The `define.amd` marker.** Once Monaco is up, `define.amd` is deleted. Without this, UMD scripts the app injects later (paper.js for the vector editor) would register as anonymous AMD modules instead of setting their global.
- **Text input.** The editor is created with `editContext: false`, which makes it use a hidden textarea. The app's global shortcut guards look for a focused TEXTAREA to decide "the user is typing", so they keep working.
- **One editor instance.** `#diff-body` is shared with the diff viewer, which clears it with `innerHTML = ''`. That only detaches the Monaco host element; `attachHost()` puts it back on the next `showFile`. `automaticLayout` handles the resize.
- **LSP comes first.** `createEditor` awaits `initLsp` before any model exists. Monaco wires its built-in TS worker the first time a JS/TS model is created, and the LSP client switches those providers off up front ([lsp.md](lsp.md)). The built-in TS worker is also set to `noSemanticValidation`, because it can't see the project and reports false "cannot find module" errors.
- **AI comes last.** `ai.js` loads after the editor. Both optional modules are imported dynamically inside try/catch, so the editor works without either one.

## Documents

- **Keys and URIs.** A document is keyed by its repo-relative path. A file outside the repo, such as an LSP jump into a stdlib stub, is keyed by its absolute path and opens **read-only** via `read-text-abs`. The model URI is always `monaco.Uri.file(absPath)`, which is what language servers expect.
- **Dirty tracking.** A document is dirty when `model.getAlternativeVersionId() !== savedVersionId`, so undoing back to the saved state clears the dirty dot, as in VS Code.
- **Edits never touch disk until saved.** Switching tabs, files or sessions writes nothing.
- **External edits** (a Claude session rewriting the file, a git checkout) arrive through `tree-changed`, which carries the changed paths, or `null` when unknown. `syncFromDisk(paths)` reloads a clean buffer as one undoable edit. A dirty buffer instead gets `conflict` and the **conflict bar** (`#editor-conflict`):
  - **Compare** opens a Monaco diff: disk on the left, your buffer on the right and editable.
  - **Keep mine** keeps your buffer; saving will overwrite the disk.
  - **Reload from disk** discards your edits.
- **Files edited in the background.** A rename or quick fix can edit files that have no tab. The LSP client loads them through `ensureModel`, and the first time such a document turns dirty it gets a **background tab** (`addBackgroundTab`), so the edit is visible and can be saved.
- **Folder switch.** `index.js` calls `onEditorRepoChanged(r.repo)`. The new root is applied synchronously, because the LSP client re-checks the root one tick later. Documents from the old root are then closed. If any have unsaved edits, the user is first offered to save them to the old location (`write-text-abs`, which only overwrites existing files).

## Tabs

These follow VS Code's rules.

- **Preview tabs.** A single-click open (`preview: true`, the default for tree/search opens) makes a preview tab, shown in italics. The next preview open replaces it in place, and its clean model is disposed. Editing a preview tab, double-clicking it, or opening the file pinned turns it into a normal tab.
- **Closing.** Closing the active tab activates the most recently used remaining tab. Closing a dirty tab asks Save / Don't Save / Cancel. Closing the last tab closes the overlay.
- **Shortcuts.** Cmd/Ctrl+W closes the tab. Cmd/Ctrl+Shift+T reopens the last closed file (up to 30 are remembered). Ctrl+PageUp/PageDown or Cmd+Alt+←/→ switch tabs.
- **Context menu.** Keep Open, Close, Close Others, Close to the Right, Close Saved, Close All, Copy Path, Reveal in Explorer.
- **Explorer renames.** Renaming a file or folder in the explorer calls `renameOpenFile(old, new)`, which moves every matching buffer, unsaved edits included.

## Gutter

- **Breakpoints.** Breakpoint state stays in `debug/state.js` ([debugger.md](debugger.md)).
  - Clicking the glyph margin or pressing F9 toggles a breakpoint; right-click opens the condition / `hits:` / `log:` prompt.
  - A faint dot previews where a click would add one.
  - Breakpoints follow edits: on each content change, the before/after text goes through `applyEditToBreakpoints`.
  - While paused, the exec line is highlighted, and hovering an identifier (with its `a.b.c` member chain) evaluates it in the paused frame via `evaluateForHover` in `debug/panel.js`.
- **Git change bars.** The committed text comes from `git-head-text` (`git show HEAD:./file`) and is cached per file. The cache is cleared on any tree change. Bars repaint 250 ms after an edit and are mirrored in the overview ruler and the minimap.
- **Inline blame.** Shown after the caret's line, 400 ms after the caret settles. It comes from `git-blame-line`, which runs `blame --porcelain -L n,n --contents -` over the *buffer*, so line numbers stay correct while dirty. The result is parsed by `parseBlamePorcelain` in `git-parse.js`. It is toggled by the `inlineBlame` setting.

## Keybindings

Monaco supplies most of VS Code's bindings: multi-cursor, Cmd/Ctrl+F/H find and replace (regex, whole word), Cmd/Ctrl+D, Alt+↑/↓ to move lines, folding, F12/Cmd-click for definitions, Shift+F12 for references, F2 rename, Cmd/Ctrl+. for quick fix, Cmd/Ctrl+Shift+O for symbols in the file, and F1 for the editor command list.

`index.js` skips its Cmd/Ctrl+Shift+O folder picker while focus is inside `.monaco-editor`. The host adds:

- **Clipboard.** Cmd/Ctrl+C/X/V are routed through main's clipboard handlers, scoped to `editorTextFocus`. Electron has no app Edit menu on macOS, so the native copy/paste events never fire. With nothing selected, copy and cut take the whole line, as in VS Code.
- **Zoom and word wrap.** Cmd/Ctrl+= / − / 0 zoom the font (stored in settings). Alt+Z toggles word wrap.
- **App-level (capture phase, while the tab strip is visible).** Cmd/Ctrl+S saves, Cmd/Ctrl+Alt+S saves all, Cmd/Ctrl+W closes the tab, Cmd/Ctrl+Shift+T reopens a closed file, Cmd/Ctrl+T opens workspace symbols, and the tab-switching keys above.
- **AI bindings** (Cmd/Ctrl+K, Cmd/Ctrl+L, Tab for ghost text) are documented in [ai-assist.md](ai-assist.md).
- **Command Palette.** The `editor-*` commands are registered from `file.js`; `registerCommands` *appends* and replaces by id.

## Status bar and Problems

- **Problems.** The error and warning counts combine the language servers' diagnostics (`getAllDiagnostics`, covering every file a server reports on) with Monaco's built-in worker markers (JSON/CSS/HTML) for files no server covers. Clicking the counts opens the Problems popover, which jumps to a problem when clicked.
- **Clickable items.**
  - Ln/Col opens Go to Line.
  - Indentation opens a picker: spaces 2/4, tabs, convert, detect.
  - EOL toggles LF/CRLF.
  - Language opens the Change Language Mode picker.
  - The LSP item restarts the server.
  - AI toggles inline completions (**off by default** — every suggestion spends the user's tokens).

## Preview

The Code | Preview switch (`#diff-preview`) appears for three kinds of file:

- **HTML** saves the buffer and then shows it in a `<webview>`.
- **Markdown** renders the *buffer* with marked into a `.md-preview` div.
  - Raw HTML is escaped, because the CSP's `script-src 'self'` would otherwise allow an injected same-origin `<script src>`.
  - Relative images resolve against the file's folder; `javascript:` links are blocked.
  - Clicked links go through `openLink`.
- **Godot `.tscn`** saves and hands off to the scene editor.

## Links

Monaco detects URLs by itself. File paths are detected by the terminal's `findTerminalLinks` and exposed as `ide-link:` URIs. A registered link opener sends them through `openLink(kind, raw, fileDir)`. `registerEditorOpener` makes Go to Definition and Peek into other files open them as tabs.

## Settings

Settings → Editor is generated from the field table in `settings-section.js`. It covers:

- **Text:** font size and family, tab size, insert spaces, detect indentation.
- **Display:** line numbers, whitespace, word wrap, minimap, sticky scroll, ligatures, bracket pairs.
- **Saving:** format on save and on paste, auto save (off / after delay / on focus change).
- **Assistance:** inline blame, AI completions, smooth scrolling.

The settings persist as one JSON blob in `localStorage` under `ide.editorSettings`. `normalizeSettings` drops wrong types and out-of-range values, so a stale blob can't break the editor.

## i18n

The editor's strings are the `editor.*`, `command.editor*` and `settings.editor*` keys, in all five locales. The parity test enforces that every locale has every key.
