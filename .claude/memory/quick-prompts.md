# Quick prompts

Per-project canned messages the user sends to sessions over and over ("improve
this UI", "make this model more realistic").

**Files.** `src/renderer/quick-prompts.js` (settings editor + picker DOM, storage),
`src/renderer/shared/quick-prompts.js` (pure list/map helpers, tested in
`test/quick-prompts.test.mjs`), `src/styles/quick-prompts.css`. Markup: `#quick-prompts`
inside `#center-body` (after `#seen-panel`) and `#quick-prompts-settings` at the end of
the Settings → Sessions page.

**Storage.** `localStorage` `ide.quickPrompts` = `{ [projectRoot]: string[] }`, keyed
by `window.api.getMainRepoPath()` so every worktree session of a project shares one
list. Renderer-only (main never needs it), so it rides the normal
`storage-sync.js` mirror into `settings.json` (see [settings.md](settings.md)). An
emptied list removes the project's key; blank/duplicate rows are never stored.

**Settings editor.** One text input per prompt plus ×, and an Add prompt button;
Enter in a row opens the next one. Every keystroke saves (normalized) and re-renders
the picker. `renderQuickPromptSettings()` rebuilds the rows on each settings open and
project change, which also drops rows left blank. With no project open, Add is
disabled and the label says to open one.

**Picker.** A small up-chevron tab docked to the bottom centre of the terminal (shifted
left by half the Seen-by-AI column when that is open). Pure CSS hover / `:focus-within`
unfolds a menu upward in the same chrome as the session bar's model/effort menus. The
wrapper is `pointer-events: none` so the folded menu's box never catches hover over
the terminal; the panel's bottom padding bridges the gap from tab to menu. Clicking a
prompt calls `submitToActiveSession` in `sessions.js` (text, then a delayed Enter via
`typePromptAfter` — same two-step submit as queued first messages) and adds
`.qp-suppressed` until the pointer leaves, so the menu doesn't stay open under the
cursor. The last row, *Edit prompts…*, opens Settings on the Sessions page.

**Visibility.** `updateSessionBar` calls `showQuickPromptsFor(s)`: shown for an active,
non-archived session, hidden otherwise. `hideSessionViews` in `viewer/center.js` hides
it with the terminals when a file or other overlay takes the centre (it has
`z-index: 6`, so it must be hidden rather than relying on DOM order).

**Wiring.** `sessions.js` imports `showQuickPromptsFor` from here, so the sender is
injected (`initQuickPrompts({ submit: submitToActiveSession })` in `index.js`) instead
of imported back, avoiding an import cycle. `refreshQuickPrompts()` runs on startup and
in `applyRepoChange`.
