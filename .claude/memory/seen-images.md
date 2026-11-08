# "Seen by AI" panel

Lets the user see every image the model was shown in a session: a 140px column to the right of the session terminal, in the order the model saw them (oldest at the top, newest at the bottom, auto-scrolled into view), each a thumbnail + `label · time`. Clicking one opens a full-window lightbox (click or Esc closes it). Desktop only; the phone chat does not show it.

## Where the images come from

No hook of its own — it rides on the existing `PostToolUse` hook every session already posts to `hook-server.js` (see [status-detection.md](status-detection.md#how-it-works)). For each payload, `forwardSeenImages()` runs the pure `seenImagesFromPayload()` (`src/main/seen-images-lib.js`, tested in `test/seen-images-lib.test.js`), which returns the images that tool call handed the model:

- **Image blocks anywhere in `tool_response`** (bounded walk): MCP `{ type: 'image', data, mimeType }` (Playwright/browser-use/computer-use screenshots), Messages-API `{ type: 'image', source: { type: 'base64', … } }`, and Claude Code's Read result `{ type: 'image', file: { base64, type } }`. These bytes win, because they are exactly what the model saw (after Claude Code's downscaling).
- **A `Read` of an image file whose result has no bytes** falls back to `tool_input.file_path`; main reads the file (skipped above 20 MB).
- **Codex `view_image`** returns `input_image` data URLs. Its generic `application/octet-stream` MIME is replaced using the input path's extension so the browser can display the returned bytes. Other Codex tool results with image blocks use the same bounded walk.

Main sends one `session-image` event per image, `{ id, tool, label, at, src }`, where `src` is a **data URL**. A path won't work here: the asset viewer and `file-url` only accept paths inside the repo, and these images are often temp screenshots or files elsewhere. Forwarding is not awaited, so the hook reply (and therefore the tool) never waits on it.

**Works in both tool-hook modes.** Light mode (Settings → "Track every tool call" off) still hooks `PostToolUse` for `Read` and `mcp__.*` (`IMAGE_RESULT_TOOLS` in `hook-events.js`): this panel needs those results. Only the Post side is hooked, so no working-tree snapshot opens and the hook stays cheap. Light mode once dropped these tools entirely, so the panel stayed empty for anyone with the setting off. The hooks apply at spawn, so a running session must be restarted to pick them up.

## Renderer

`src/renderer/seen-images.js` keeps the history per session, in memory only (capped at 60 data URLs per session; dropped on `session-evicted`; not persisted across restarts). `sessions.js` `updateSessionBar()` calls `showSeenImagesFor(activeId | null)`, so the panel follows the active session. The session bar's eye button (`#session-seen`, hidden while the session has no images) shows the count and toggles the panel. The open/closed choice is stored in `localStorage` `ide.seenPanelOpen` (default open). The panel only appears once the session has an image.

Layout: `#seen-panel` sits in `#center-body` right after `#terminal-host`. While it's open, `#center-body.seen-open` pulls the terminal host's right edge in by `--seen-panel-width`, and the host's `ResizeObserver` (`panes.js`) refits the terminal. The center overlays (file/diff/asset/…) come later in the DOM, so they still cover it. Styles: `src/styles/seen-images.css`. Strings: `seen.*`.
