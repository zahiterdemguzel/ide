# Session status detection

Each session shows a colored dot driven automatically by Claude Code hooks — no terminal scraping.

## Color → meaning

| State | Color | Trigger |
|---|---|---|
| Idle | gray | a freshly created session, or `SessionStart` — started, but no work in flight yet |
| Working | yellow (spinning) | `UserPromptSubmit`, `PreToolUse` (and any non-push `PostToolUse`) |
| Needs input | green (glowing) | `Notification`, `PermissionRequest` |
| Completed | green | `Stop`, or the PTY exits |
| Committed / pushed | purple | a successful per-session **Commit changes**, or a `PostToolUse` whose Bash command matches `git push` |
| Interrupted | red | only on reopen — a session that was mid-flight when the app last closed (see [Persistence](#persistence-across-restarts)) |

A just-created session stays gray (idle) until the user submits the first prompt; yellow ("working") is reserved for an agent actively responding. Because "working" is the only ongoing state, its dot also **animates**: it turns into a ring spinner (a faint ring with one bright rotating segment) so an in-progress session is distinguishable from a paused one at a glance, not just by hue. A solid dot can't show rotation, so the gap in the ring is what makes the motion visible. It is intentionally **not** gated behind `prefers-reduced-motion` — it's the only liveness cue, and Windows reports "reduce" whenever the OS animation setting is off, which would silently hide it. (See `.dot.working` in `src/styles/sessions.css`.)

"Needs input" and "Completed" share one green signal — both mean the session wants the user's attention; the glow on "Needs input" keeps an active prompt slightly more eye-catching. The two remain distinct states (and tooltips) in code.

## How it works

`hooksSettings()` builds an inline hooks config and passes it to each session via the `claude --settings <json>` flag — so the user's global `~/.claude/settings.json` is **never modified**. Every hook is a `command` hook that `curl`s its stdin payload to a local `http` server started in `startHookServer()`. `eventToState()` maps `hook_event_name` → state; the result is pushed to the renderer keyed by `session_id` (which equals the `--session-id` we spawned with).

The same payloads feed `recordSessionActivity()`, which records each session's first prompt (`UserPromptSubmit.prompt`) and its edits — each `PostToolUse` of a file tool is kept as a replayable op (`old_string`/`new_string`/content), not just the path. That op log is what lets the per-session commit reconstruct and commit only that session's hunks. It also diffs `git status` across each non-edit tool call (`PreToolUse` → `PostToolUse`) to attribute binary creates, renames/moves, and deletes — changes no text op can express — to the session (see [Tracking filesystem changes](architecture.md#tracking-filesystem-changes)). Because the `PreToolUse` snapshot must predate the tool's writes, the hook server **awaits** `recordSessionActivity()` before answering the hook (a command hook blocks its tool until `curl` returns). See [architecture.md](architecture.md).

## Persistence across restarts

The dot state is saved with the session snapshot so it survives closing the app. As the hook server maps each event to a state, it also calls `sessions.setSessionState()` to record the live value on the session record (and a successful per-session commit marks it `pushed`); `serializeSession()` then writes it to `sessions.json`. Only a session that was **actively running** when the app closed (`working` or `needs-input`) is rewritten by `persistedState()` to **`interrupted`** (red), because the restored session's Claude process can't outlive the app — the in-flight state isn't real anymore. The settled states are kept verbatim: `completed` (green), `pushed` (purple), and `idle` (gray — a session created but never used). On startup `restoreSessionRow()` paints the dot from the persisted state; selecting the session resumes its Claude process, which then drives the dot live again. `persistedState()` lives in the Electron-free `session-persist.js` and is unit-tested.

Resuming a saved session fires a `SessionStart` (→ `idle`), which would otherwise reset a reopened session's dot to gray the instant the user clicks it. So the hook server **suppresses an `idle` that would downgrade an already-meaningful state**: it checks `sessions.getSessionState()` and only applies `idle` when the session has no prior state (a brand-new session is already idle, so it's unaffected). A reopened `completed`/`pushed`/`interrupted` session therefore keeps its colour until real new work (`working`/`needs-input`/…) moves it.

## Load-bearing assumptions

- **Hook event names** (`events[]` in `main.js`). If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown names are harmless — they simply never fire.
- **`curl` on PATH** to deliver hook payloads (ships with Windows 11).
- **`session_id` correlation**: the spawned `--session-id` must equal the `session_id` field in hook payloads.
