# Session status detection

The session dot follows CLI hooks and checks Claude Code’s tool processes when a turn ends.

## Color → meaning

| State | Color | Trigger |
|---|---|---|
| Idle | gray | a freshly created session, or `SessionStart` — started, but no work in flight yet |
| Working | yellow (spinning) | `UserPromptSubmit`, `PreToolUse` (and any non-push `PostToolUse`) |
| Needs input | amber exclamation icon plus visible label on desktop | **blocking asks only**: `PermissionRequest`, a `Notification` whose message names a permission ("Claude needs your permission to use X"), and `PreToolUse` for an **ask tool** (see below). The generic idle `Notification` ("Claude is waiting for your input") follows *every* unattended turn — including ones merely ending with a prose question, which agents do constantly — so it maps to null and leaves the dot alone |
| Completed | green | The main turn ends and all background work has finished, or the PTY exits |
| Background work | green (spinning) | The **main** conversation is ready for input while subagents, forks, or Claude tool shells are still running. State id `bg-agents` |
| Committed / pushed | purple | a successful per-session **Commit changes**, or a `PostToolUse` whose Bash command matches `git push` |
| Interrupted | red | `StopFailure` — the CLI fires it **instead of** `Stop` when an API error (usage limit, auth, overload) ends the turn; without it such a session sat yellow forever. Also: the agent was stopped while actively **working**: an ESC/Ctrl+C followed by a fresh CLI transcript cancellation record, archiving a working session, or reopening one that was working when the app closed (see [Interrupting a turn](#interrupting-a-turn) and [Persistence](#persistence-across-restarts)) |

A just-created session stays gray (idle) until the user submits the first prompt; yellow ("working") is reserved for an agent actively responding. The working dot animates as a ring spinner (a faint ring with one bright rotating segment) so an in-progress session is distinguishable from a paused one at a glance, not just by hue. A solid dot can't show rotation, so the gap in the ring is what makes the motion visible. It is intentionally **not** gated behind `prefers-reduced-motion` — it's the only liveness cue, and Windows reports "reduce" whenever the OS animation setting is off, which would silently hide it. (See `.dot.working` in `src/styles/sessions.css`.)

`bg-agents` is the **same spinner in green**: hue answers "can I type here?" (green = yes, the chat has settled), motion answers "is anything still running?" (spinning = yes, background agents). It is not `completed` — the run isn't over, so no chime, no celebration, and a restart collapses it to `interrupted` exactly like `working`; and it is not `working`, because nothing is holding the chat.

On desktop, a session with a blocking prompt shows an amber exclamation icon and a localized **Needs input** label. **Next Waiting Session** in the Command Palette cycles through those sessions in sidebar order within the open project, including sessions hidden by search.

**Ask tools** (`isAskTool` in `ask-lib.js` — currently just `AskUserQuestion`). Claude *asking the user a multiple-choice question* is a tool call, not a notification: Claude Code fires no `Notification` for it, only an ordinary `PreToolUse`. Mapped like any other tool that would leave the session **yellow with a question on screen and nothing saying so** — and, worse, leave the phone (which renders the session as a chat and never sees the terminal) never knowing to ask it at all. So a `PreToolUse` naming an ask tool means `needs-input`; its `PostToolUse` — the answer landing — puts it back to `working` like any other tool. That same payload is where the question itself is read from (its `tool_input` carries every question and option), because the painted box cannot be read back; see [remote-access.md](remote-access.md).

## The dot on mobile

The phone uses the same state IDs. `mobile/src/components/StateDot.tsx` renders them in the sessions list and chat header. It uses RN `Animated` for the yellow ring spinner (700ms linear loop, reused in green for `bg-agents`), a green glow for `needs-input`, and the working → completed pop + expanding ring (500/600ms). Colors come from `stateColor` in `mobile/src/theme.ts`. The dot sits in a fixed-width slot to keep the text aligned as the indicator changes size.

The chime is desktop-only: the phone plays the visual celebration but no sound.

## Finish notification

The moment a session goes from **working** (yellow) to **completed** (green) — the only transition that means "the thing you were waiting on just finished" — the sidebar plays a one-shot attention cue: the row flashes green and its dot bounces with an expanding ring (`.just-finished` in `src/styles/sessions.css`), and a short chime plays. The result is usually off-screen (a background session, or the user looking elsewhere), so this pulls the eye back. `setState()` (renderer `sessions.js`) detects the transition via the pure `isCompletionTransition(prev, next)` and calls `celebrateFinish()`, which (re)applies the animation classes and calls `playNotification()`.

Only **working → completed** (or **bg-agents → completed**, when the last background work finishes) fires it — not `needs-input` (also green) and not any already-settled state moving to `completed` (e.g. a restored session). The trigger is the pure, unit-tested `isCompletionTransition` in `src/renderer/shared/notify.js` (`test/notify.test.mjs`).

`deriveStatus()` tracks subagents by `agent_id` from `SubagentStart` through `SubagentStop`. Both Claude and Codex wire these hooks. When `Task` or `Agent` first announces a spawn without an ID, the first event from that agent claims the open slot. An identified spawn stays active across quiet periods and new main turns. A repeated stop for the same ID is ignored, and a new start lets a resumed agent reuse that ID.

The reducer also tracks forks by conversation ID when the hook carries a different CLI session ID. Each conversation's stop clears its own activity. Agent IDs seen only in context hooks and conversation IDs expire after five minutes of silence to account for abandoned forks. A main-thread prompt resets unmatched spawn bookkeeping when no conversation or identified agent is active.

When the hooks indicate completion for a live Claude session, the hook server checks its PTY's process tree for tool shells before publishing the state. It recognizes Bash and PowerShell wrappers through the working-directory file they write after the command. This excludes hooks, status-line refreshes, and MCP launch shells. If a tool shell is present, the server publishes `bg-agents` and checks again every two seconds until the shell exits. A single scan serves all pending sessions. New foreground activity takes over through the usual hooks, and PTY teardown clears both kinds of tracking.

The chime is one of four sounds the user picks in **Settings → Notification sound** (see [settings.md](settings.md#notification-sound)). The sounds are **synthesized with the Web Audio API**, not shipped as audio files — no binary asset, works offline under `file://`, matching the app's pure-CSS/synth approach. `notify.js` owns the `SOUNDS` registry (each a list of oscillator voices with a pluck/bell envelope), the persisted choice (`localStorage` `ide.notifySound`, default `chime`), and a shared lazily-created `AudioContext` (resumed on each play to survive the autoplay policy).

The same transition can also raise an OS-level desktop notification — opt-in via **Settings → Desktop notifications** (off by default, since unlike the chime it can steal window focus). See [settings.md](settings.md#general-preferences).

## How it works

`hooksSettings()` builds an inline hooks config and passes it to each session via the `claude --settings <json>` flag — so the user's global `~/.claude/settings.json` is **never modified**. (The same inline settings also carry the per-session [token meter](architecture.md#per-session-token-meter)'s `statusLine`, and `disableAgentView: true` — this app already lists sessions side by side, so Claude Code's own `claude agents` background-agent screen is turned off in every spawned session. There's no CLI flag for it; the setting and the `CLAUDE_CODE_DISABLE_AGENT_VIEW` env var are the only toggles.) Every hook is a `command` hook that `curl`s its stdin payload to a local `http` server started in `startHookServer()`. `eventToState()` maps `hook_event_name` → state; the result is pushed to the renderer keyed by `session_id`.

**Every hook URL is tagged `?ide=<our session id>`** (`hooksSettings(port, statusLineCommand, ideId)`), and `normalizeHookPayload` rewrites `payload.session_id` to that id whenever the CLI reports a different one. Claude *is* spawned with `--session-id <our uuid>`, but it does not keep it for life: **`/fork` continues the conversation in a brand-new session** with a new id and a new transcript file. Those payloads named a session the app had never heard of, so `recordSessionActivity()` dropped them at its `sessions.get()` miss — a forked chat's file edits were never tracked (and so never committable), its dot never moved, and its chat never followed the new transcript. The URL tag is the one thing the CLI cannot rewrite, so it is what keeps a fork attributed to the session that spawned it. The CLI's own current id is recorded as the session's `agentSessionId`, and it is also what `deriveStatus` uses as the payload's `originId` so a fork's `Stop` can't settle the whole session (see [Finish notification](#finish-notification)). (Ordinary subagents need none of this — a `Task`/`Agent` subagent's hooks already fire with the parent `session_id`, plus an `agent_id`.)

The same payloads feed `recordSessionActivity()`, which records each session's first prompt (`UserPromptSubmit.prompt`) and its edits — each `PostToolUse` of a file tool is kept as a replayable op (`old_string`/`new_string`/content), not just the path. That op log is what lets the per-session commit reconstruct and commit only that session's hunks. It also diffs `git status` across each non-edit tool call (`PreToolUse` → `PostToolUse`) to attribute binary creates, renames/moves, and deletes — changes no text op can express — to the session (see [Tracking filesystem changes](architecture.md#tracking-filesystem-changes)). Because the `PreToolUse` snapshot must predate the tool's writes, the hook server **awaits** `recordSessionActivity()` before answering the hook (a command hook blocks its tool until `curl` returns). See [architecture.md](architecture.md).

### Light tool hooks (Settings → "Track every tool call")

Every hook is a `curl` process the tool **waits on**, and a Bash/MCP `PreToolUse`/`PostToolUse` also costs a working-tree scan (`git status` plus reading each dirty file, up to `fs-content.LIMITS`). A session running many subagents fires these for every Read/Grep/Bash call of every subagent, which is what made the app lag. So `hooksSettings(port, statusLine, ideId, { detailedToolHooks })` can narrow the two tool events' `matcher` (a regex on the tool name) — `lightToolMatchers()` in `hook-events.js`:

- `PreToolUse`: `Task|Agent` (subagent spawn count), `AskUserQuestion` (needs-input + phone question card), `Write|Edit|MultiEdit|NotebookEdit` (pending-edit marks);
- `PostToolUse`: the same plus `Bash` (the `git push` → purple sniff and the bulk-VCS re-baseline), and `Read`/`mcp__.*` (the images the model is shown, for the [Seen by AI panel](seen-images.md)). No Bash *Pre* means no per-tool snapshot ever opens, so the Post is cheap.

Every other event keeps `matcher: '*'`. The trade: Bash/MCP file changes are attributed by the turn-wide diff at each `Stop`/`SubagentStop` (`turnFsPlan`) rather than per tool call, so two sessions writing the same repo at once attribute less precisely, and the row's tool line only names the matched tools. Default is **on** (every tool hooked); the renderer pushes the flag to main (`set-tool-hooks-enabled` → `hookServer.setDetailedToolHooks`) and it applies at **spawn** — a live session keeps the hooks it started with. Codex sessions' `-c hooks.*` overrides are unaffected. Tested in `test/hook-events.test.js`.

Two cheaper fixes apply in both modes: the hook server **doesn't re-send an unchanged state** (most hooks of a busy session re-derive the `working` it already shows; each push was IPC + a phone broadcast), and the per-event debug log (`ide-hook-debug.log` in the OS temp dir — a stat + sync append per hook) is now **opt-in via `IDE_HOOK_DEBUG=1`**. The status scan (`scanStatus` in `sessions.js`) reads dirty files with `fs.promises`, so a scan no longer blocks the main process (and every terminal's output with it).

## Interrupting a turn

Escape and Ctrl+C still go straight to the terminal. During active work or a blocking prompt, either key also starts a brief check of the current conversation’s transcript. Claude Code records a cancellation as a standalone user interruption marker. Codex records a `turn_aborted` event with reason `interrupted`. The check requires a fresh record and expires silently. A normal `Stop` keeps the completion path, and a new prompt cancels the old check.

A confirmed interruption ends the conversation’s tracked turn and clears its blocking prompt. Background work keeps its spinner until it settles, at which point the interrupted turn shows red. Archiving or restarting during active work still uses `persistedState()` to restore the session as interrupted.

## Persistence across restarts

The dot state is saved with the session snapshot so it survives closing the app. As the hook server maps each event to a state, it also calls `sessions.setSessionState()` to record the live value on the session record (and a successful per-session commit marks it `pushed`); `serializeSession()` then writes it to the session's own file (see [Session persistence](architecture.md#session-persistence)), saved immediately on the state change. Only a session that was **actively working** when the app closed (`working` — the yellow spinner) is rewritten by `persistedState()` to **`interrupted`** (red), because that turn was cut off and the restored session's Claude process can't outlive the app. A `needs-input` session was *paused waiting for the user*, not crunching — it shows green like a finished one, so it reopens `completed` (green) rather than red; the live input prompt can't survive a restart, so the glowing needs-input cue collapses to plain settled green. The other settled states are kept verbatim: `completed` (green), `pushed` (purple), and `idle` (gray — a session created but never used). On startup `restoreSessionRow()` paints the dot from the persisted state; selecting the session resumes its Claude process, which then drives the dot live again. `persistedState()` lives in the Electron-free `session-persist.js` and is unit-tested.

Resuming a saved session fires a `SessionStart` (→ `idle`), which would otherwise reset a reopened session's dot to gray the instant the user clicks it. So the hook server **suppresses an `idle` that would downgrade an already-meaningful state**: it checks `sessions.getSessionState()` and only applies `idle` when the session has no prior state (a brand-new session is already idle, so it's unaffected). A reopened `completed`/`pushed`/`interrupted` session therefore keeps its colour until real new work (`working`/`needs-input`/…) moves it.

## Codex sessions

Codex CLI sessions (`codex:` models — see [codex.md](codex.md)) feed the **same pipeline**: their hooks are injected as `-c hooks.<Event>=…` spawn overrides posting to the same server, and their payloads are Claude-shaped. Two deltas live in `hook-events.js`: `deriveStatus` counts Codex's own **`SubagentStart`** event as a spawn signal (handled before the `agent_id` early-return so it balances its `SubagentStop` from either context), and **`normalizeHookPayload`** rewrites the Codex-invented `session_id` back to the IDE's id using the `?ide=` query param on the hook URL (recording the original as the session's `agentSessionId`, which `codex resume` needs). `hook-server.js` also strips a leading UTF-8 BOM before `JSON.parse` — Codex-on-Windows runs hook commands through PowerShell, whose stdin piping prepends one. The `PostToolUse` git-push sniff accepts an argv-array `command` too.

## Load-bearing assumptions

- **Hook event names** (`events[]` in `main.js`). If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown names are harmless — they simply never fire.
- **`curl` on PATH** to deliver hook payloads (ships with Windows 11). Codex hook commands must say `curl.exe` and quote `'@-'` (PowerShell).
- **`session_id` correlation**: guaranteed by the `?ide=` tag on every hook URL plus `normalizeHookPayload` — for Codex (which has no `--session-id`) and equally for a Claude session that has forked into a new id.
