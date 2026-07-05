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
| Interrupted | red | the agent was stopped while actively **working**: ESC/Ctrl+C typed while working, archiving a working session, or reopening one that was working when the app closed (see [Interrupting a turn](#interrupting-a-turn) and [Persistence](#persistence-across-restarts)) |

A just-created session stays gray (idle) until the user submits the first prompt; yellow ("working") is reserved for an agent actively responding. Because "working" is the only ongoing state, its dot also **animates**: it turns into a ring spinner (a faint ring with one bright rotating segment) so an in-progress session is distinguishable from a paused one at a glance, not just by hue. A solid dot can't show rotation, so the gap in the ring is what makes the motion visible. It is intentionally **not** gated behind `prefers-reduced-motion` — it's the only liveness cue, and Windows reports "reduce" whenever the OS animation setting is off, which would silently hide it. (See `.dot.working` in `src/styles/sessions.css`.)

"Needs input" and "Completed" share one green signal — both mean the session wants the user's attention; the glow on "Needs input" keeps an active prompt slightly more eye-catching. The two remain distinct states (and tooltips) in code.

## Finish notification

The moment a session goes from **working** (yellow) to **completed** (green) — the only transition that means "the thing you were waiting on just finished" — the sidebar plays a one-shot attention cue: the row flashes green and its dot bounces with an expanding ring (`.just-finished` in `src/styles/sessions.css`), and a short chime plays. The result is usually off-screen (a background session, or the user looking elsewhere), so this pulls the eye back. `setState()` (renderer `sessions.js`) detects the transition via the pure `isCompletionTransition(prev, next)` and calls `celebrateFinish()`, which (re)applies the animation classes and calls `playNotification()`.

Only **working → completed** fires it — not `needs-input` (also green) and not any already-settled state moving to `completed` (e.g. a restored session). The trigger is the pure, unit-tested `isCompletionTransition` in `src/renderer/shared/notify.js` (`test/notify.test.mjs`).

**A session completes on its last agent, not its first.** Background subagents (spawned via the `Task` tool) can outlive the main agent's turn: Claude Code fires the main `Stop` while they keep working, then one `SubagentStop` per subagent as each finishes. So `completed` (and its chime) must wait for **all** agents. `deriveStatus(payload, tracking)` (pure, in `hook-events.js`) layers this over `eventToState`: it counts `PreToolUse{tool:Task}` spawns against `SubagentStop`s and only settles to `completed` once the main agent has stopped **and** the subagent count is zero — otherwise the session stays `working`. The hook server (`hook-server.js`) holds the per-session `{ subagents, mainStopped }` tracking in an in-memory `Map` (nothing runs across a restart, so it isn't persisted) and threads it through each event. `SubagentStop` is in the `hooksSettings()` event list for this reason; a `UserPromptSubmit` resets the tracking so an orphaned count can't leak into the next turn. Unit-tested in `test/hook-events.test.js`. Like the working spinner, the animation is **not** gated behind `prefers-reduced-motion` — it's a functional attention cue and Windows reports "reduce" whenever OS animations are off, which would silently kill it; it's a single short pulse, not sustained motion.

Every hook payload that carries `agent_id` fired **inside a Task-tool subagent's own context**, never the main thread — Claude Code sets it only there (main-thread events never have it), including on some CLI versions where a subagent's own stop is mis-routed as `Stop` instead of `SubagentStop`. `eventToState()` (`src/main/hook-events.js`) therefore ignores any payload with `agent_id` up front, before the event-name switch, so a subagent finishing never fakes a `working → completed` transition and fires the chime early/spuriously. The wrapping Task tool call still keeps the session `working` via its own (agent_id-less) `PreToolUse`/`PostToolUse`, so nothing is lost by ignoring the subagent's internal events.

The chime is one of four sounds the user picks in **Settings → Notification sound** (see [settings.md](settings.md#notification-sound)). The sounds are **synthesized with the Web Audio API**, not shipped as audio files — no binary asset, works offline under `file://`, matching the app's pure-CSS/synth approach. `notify.js` owns the `SOUNDS` registry (each a list of oscillator voices with a pluck/bell envelope), the persisted choice (`localStorage` `ide.notifySound`, default `chime`), and a shared lazily-created `AudioContext` (resumed on each play to survive the autoplay policy).

The same transition can also raise an OS-level desktop notification — opt-in via **Settings → Desktop notifications** (off by default, since unlike the chime it can steal window focus). See [settings.md](settings.md#general-preferences).

## How it works

`hooksSettings()` builds an inline hooks config and passes it to each session via the `claude --settings <json>` flag — so the user's global `~/.claude/settings.json` is **never modified**. (The same inline settings also carry the per-session [token meter](architecture.md#per-session-token-meter)'s `statusLine`, and `disableAgentView: true` — this app already lists sessions side by side, so Claude Code's own `claude agents` background-agent screen is turned off in every spawned session. There's no CLI flag for it; the setting and the `CLAUDE_CODE_DISABLE_AGENT_VIEW` env var are the only toggles.) Every hook is a `command` hook that `curl`s its stdin payload to a local `http` server started in `startHookServer()`. `eventToState()` maps `hook_event_name` → state; the result is pushed to the renderer keyed by `session_id` (which equals the `--session-id` we spawned with).

The same payloads feed `recordSessionActivity()`, which records each session's first prompt (`UserPromptSubmit.prompt`) and its edits — each `PostToolUse` of a file tool is kept as a replayable op (`old_string`/`new_string`/content), not just the path. That op log is what lets the per-session commit reconstruct and commit only that session's hunks. It also diffs `git status` across each non-edit tool call (`PreToolUse` → `PostToolUse`) to attribute binary creates, renames/moves, and deletes — changes no text op can express — to the session (see [Tracking filesystem changes](architecture.md#tracking-filesystem-changes)). Because the `PreToolUse` snapshot must predate the tool's writes, the hook server **awaits** `recordSessionActivity()` before answering the hook (a command hook blocks its tool until `curl` returns). See [architecture.md](architecture.md).

## Interrupting a turn

Stopping an agent mid-response turns the dot **red (interrupted)**. Claude Code emits **no hook** for an interrupt, so unlike every other state this one isn't hook-driven — it's detected in the main process and pushed to the renderer on the same `status` channel (then persisted via `setSessionState`).

- **ESC / Ctrl+C while working.** The `pty-input` handler (`src/main/sessions.js`) runs each keystroke through the pure `interruptState(data, current)` (`hook-events.js`): a bare ESC (`\x1b`) or Ctrl+C (`\x03`) maps to `interrupted` **only when the session is currently `working`** — in any other state those bytes mean other things (closing a menu, etc.), and arrow/function keys arrive as multi-byte sequences (`\x1b[…`) so an exact match never catches them. The next prompt fires `UserPromptSubmit` → `working` again.
- **Archiving an active session.** Suspending (archiving) a session kills its Claude process, so a session that was `working` can't keep running. The `suspend-session` handler reuses `persistedState()` (the same rule app-close applies) to collapse `working` to `interrupted`; a `needs-input` session was only paused for the user, so it collapses to green (`completed`), and the settled states (`completed`/`pushed`/`idle`) pass through unchanged.

Both paths are unit-tested via the pure helpers (`interruptState` in `test/hook-events.test.js`; `persistedState` in `test/session-persist.test.js`).

## Persistence across restarts

The dot state is saved with the session snapshot so it survives closing the app. As the hook server maps each event to a state, it also calls `sessions.setSessionState()` to record the live value on the session record (and a successful per-session commit marks it `pushed`); `serializeSession()` then writes it to the session's own file (see [Session persistence](architecture.md#session-persistence)), saved immediately on the state change. Only a session that was **actively working** when the app closed (`working` — the yellow spinner) is rewritten by `persistedState()` to **`interrupted`** (red), because that turn was cut off and the restored session's Claude process can't outlive the app. A `needs-input` session was *paused waiting for the user*, not crunching — it shows green like a finished one, so it reopens `completed` (green) rather than red; the live input prompt can't survive a restart, so the glowing needs-input cue collapses to plain settled green. The other settled states are kept verbatim: `completed` (green), `pushed` (purple), and `idle` (gray — a session created but never used). On startup `restoreSessionRow()` paints the dot from the persisted state; selecting the session resumes its Claude process, which then drives the dot live again. `persistedState()` lives in the Electron-free `session-persist.js` and is unit-tested.

Resuming a saved session fires a `SessionStart` (→ `idle`), which would otherwise reset a reopened session's dot to gray the instant the user clicks it. So the hook server **suppresses an `idle` that would downgrade an already-meaningful state**: it checks `sessions.getSessionState()` and only applies `idle` when the session has no prior state (a brand-new session is already idle, so it's unaffected). A reopened `completed`/`pushed`/`interrupted` session therefore keeps its colour until real new work (`working`/`needs-input`/…) moves it.

## Load-bearing assumptions

- **Hook event names** (`events[]` in `main.js`). If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown names are harmless — they simply never fire.
- **`curl` on PATH** to deliver hook payloads (ships with Windows 11).
- **`session_id` correlation**: the spawned `--session-id` must equal the `session_id` field in hook payloads.
