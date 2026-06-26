# Session status detection

Each session shows a colored dot driven automatically by Claude Code hooks — no terminal scraping.

## Color → meaning

| State | Color | Trigger |
|---|---|---|
| Idle | gray | a freshly created session, or `SessionStart` — started, but no work in flight yet |
| Working | yellow | `UserPromptSubmit`, `PreToolUse` (and any non-push `PostToolUse`) |
| Needs input | green (glowing) | `Notification`, `PermissionRequest` |
| Completed | green | `Stop`, or the PTY exits |
| Committed / pushed | purple | a successful per-session **Commit changes**, or a `PostToolUse` whose Bash command matches `git push` |

A just-created session stays gray (idle) until the user submits the first prompt; yellow ("working") is reserved for an agent actively responding.

"Needs input" and "Completed" share one green signal — both mean the session wants the user's attention; the glow on "Needs input" keeps an active prompt slightly more eye-catching. The two remain distinct states (and tooltips) in code.

## How it works

`hooksSettings()` builds an inline hooks config and passes it to each session via the `claude --settings <json>` flag — so the user's global `~/.claude/settings.json` is **never modified**. Every hook is a `command` hook that `curl`s its stdin payload to a local `http` server started in `startHookServer()`. `eventToState()` maps `hook_event_name` → state; the result is pushed to the renderer keyed by `session_id` (which equals the `--session-id` we spawned with).

The same payloads feed `recordSessionActivity()`, which records each session's first prompt (`UserPromptSubmit.prompt`) and its edits — each `PostToolUse` of a file tool is kept as a replayable op (`old_string`/`new_string`/content), not just the path. That op log is what lets the per-session commit reconstruct and commit only that session's hunks. It also diffs `git status` across each non-edit tool call (`PreToolUse` → `PostToolUse`) to attribute binary creates, renames/moves, and deletes — changes no text op can express — to the session (see [Tracking filesystem changes](architecture.md#tracking-filesystem-changes)). Because the `PreToolUse` snapshot must predate the tool's writes, the hook server **awaits** `recordSessionActivity()` before answering the hook (a command hook blocks its tool until `curl` returns). See [architecture.md](architecture.md).

## Load-bearing assumptions

- **Hook event names** (`events[]` in `main.js`). If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown names are harmless — they simply never fire.
- **`curl` on PATH** to deliver hook payloads (ships with Windows 11).
- **`session_id` correlation**: the spawned `--session-id` must equal the `session_id` field in hook payloads.
