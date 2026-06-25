# Session status detection

Each session shows a colored dot driven automatically by Claude Code hooks — no terminal scraping.

## Color → meaning

| State | Color | Trigger |
|---|---|---|
| Working | gray | `SessionStart`, `UserPromptSubmit`, `PreToolUse` |
| Needs input | red | `Notification`, `PermissionRequest` |
| Completed | green | `Stop`, or the PTY exits |
| Pushed | purple | `PostToolUse` whose Bash command matches `git push` |

## How it works

`hooksSettings()` builds an inline hooks config and passes it to each session via the `claude --settings <json>` flag — so the user's global `~/.claude/settings.json` is **never modified**. Every hook is a `command` hook that `curl`s its stdin payload to a local `http` server started in `startHookServer()`. `eventToState()` maps `hook_event_name` → state; the result is pushed to the renderer keyed by `session_id` (which equals the `--session-id` we spawned with).

## Load-bearing assumptions

- **Hook event names** (`events[]` in `main.js`). If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown names are harmless — they simply never fire.
- **`curl` on PATH** to deliver hook payloads (ships with Windows 11).
- **`session_id` correlation**: the spawned `--session-id` must equal the `session_id` field in hook payloads.
