// Pure (Electron-free) hook logic for the status dots: the event -> state mapping,
// the resume-downgrade rule, and the per-session settings JSON. The http server,
// sessions/IPC glue, and the live hookPort live in hook-server.js. Kept here so
// this — the heart of .claude/memory/status-detection.md — stays unit-tested
// (test/hook-events.test.js).

// The tools whose whole purpose is to block on the user: Claude asking a
// multiple-choice question. The question itself is read off this same payload by
// src/main/ask-lib.js.
const { isAskTool } = require('./ask-lib');

// Map a Claude Code hook payload to a session status, or null to leave it
// unchanged. PostToolUse sniffs the command for a `git push` so the dot can flip
// to "pushed"; everything else maps by event name.
function eventToState(payload) {
  // `agent_id` is present only when the hook fires inside a Task-tool subagent's
  // own context (Claude Code docs: "Use this to distinguish subagent hook calls
  // from main-thread calls"). A subagent's own Stop/UserPromptSubmit/etc. must
  // never drive the session dot or the completion chime — the wrapping Task
  // tool call already keeps the session "working" via its own PreToolUse/
  // PostToolUse, which fire without agent_id since the main thread invokes them.
  // This also guards against CLI versions where a subagent's stop is mis-routed
  // as `Stop` instead of `SubagentStop`.
  if (payload.agent_id) return null;
  switch (payload.hook_event_name) {
    case 'Stop': return 'completed';
    // Claude Code fires Notification for two very different things: a permission
    // prompt ("Claude needs your permission to use Bash") and the generic idle
    // notice ("Claude is waiting for your input"), which follows *every* finished
    // turn once it sits unattended — including turns that merely end with a prose
    // question. Only the permission one actually blocks the session, so only it may
    // light the green "needs you" cue; agents end turns with questions all the
    // time, and needs-input is reserved for real blocking asks (this, the
    // PermissionRequest event, and the ask tool's PreToolUse below).
    case 'Notification':
      return /permission/i.test(String(payload.message || '')) ? 'needs-input' : null;
    case 'PermissionRequest': return 'needs-input';
    case 'PostToolUse': {
      // Codex may hand a shell tool's command over as an argv array; joined it
      // sniffs the same as Claude's single string.
      const raw = payload.tool_input && payload.tool_input.command;
      const c = Array.isArray(raw) ? raw.join(' ') : raw;
      if (c && /git\s+push/.test(c)) return 'pushed';
      return 'working';
    }
    // A session that has only just started has no work in flight yet — it sits
    // idle (gray) until the user submits the first prompt. Yellow ("working") is
    // reserved for an agent actively responding.
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit': return 'working';
    // Claude asking the user a multiple-choice question is a *tool call* — so the
    // only hook it fires is an ordinary PreToolUse, and Claude Code sends no
    // Notification for it. Left as `working` the session would sit yellow with a
    // question on screen and nothing saying so, and the phone (which renders the
    // session as a chat and never sees the terminal) would never learn to ask it.
    case 'PreToolUse': return isAskTool(payload.tool_name) ? 'needs-input' : 'working';
    default: return null;
  }
}

// Whether a main-thread PreToolUse payload spawns a subagent. Claude Code has
// named the spawning tool `Task` historically and `Agent` on newer CLIs — both
// count. Each spawn is later balanced by exactly one subagent stop, so counting
// spawns against stops tells us how many agents are still in flight.
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
function spawnsSubagent(payload) {
  return payload.hook_event_name === 'PreToolUse' && SUBAGENT_TOOLS.has(payload.tool_name);
}

// Whether a payload signals a subagent finishing. `SubagentStop` is the canonical
// event; some CLI versions instead mis-route it as a `Stop` fired in the
// subagent's own context (carrying its agent_id), so that shape must count as the
// same signal — otherwise the in-flight count never drains and the session hangs
// yellow forever.
function isSubagentStop(payload) {
  return payload.hook_event_name === 'SubagentStop'
    || (payload.hook_event_name === 'Stop' && Boolean(payload.agent_id));
}

// Layer subagent-aware gating over eventToState so the finish chime waits for the
// LAST agent in a session, not the first. Background subagents can outlive the
// main agent's turn: Claude Code fires the main `Stop` while they keep working,
// then one subagent stop per subagent as each finishes. We hold the `completed`
// state — and with it the celebrate/chime the renderer triggers on the
// working -> completed transition — until the main agent has stopped AND no
// subagents remain in flight.
//
// `tracking` is the caller-held per-session bookkeeping { subagents, mainStopped }.
// deriveStatus returns the state to apply (or null to leave the dot unchanged)
// alongside the next tracking. Pure and unit-tested (test/hook-events.test.js).
function deriveStatus(payload, tracking = { subagents: 0, mainStopped: false }) {
  let { subagents, mainStopped } = tracking;
  // Agent ids already counted as stopped this turn. A finishing subagent can
  // announce itself twice — a `SubagentStop` AND a mis-routed `Stop`, both with
  // its agent_id — and counting both drains the in-flight count for two agents,
  // settling the session (and ringing the chime) while another background agent
  // is still running. Only the first stop per agent_id may decrement.
  let stoppedIds = tracking.stoppedIds || [];
  const ev = payload.hook_event_name;
  const subagentStopped = isSubagentStop(payload);

  if (subagentStopped) {
    const id = payload.agent_id;
    if (id && stoppedIds.includes(id)) {
      // Duplicate stop for an agent already drained — ignore entirely.
      return { state: null, tracking };
    }
    if (id) stoppedIds = [...stoppedIds, id];
    subagents = Math.max(0, subagents - 1);
  } else if (ev === 'SubagentStart') {
    // Codex announces a subagent spawning as its own event (Claude signals it via
    // the Task/Agent PreToolUse below). Counted before the agent_id early-return
    // so the count balances its SubagentStop regardless of which context Codex
    // fires it from; a spawn also proves the main agent is running.
    subagents += 1;
    mainStopped = false;
    return { state: 'working', tracking: { subagents, mainStopped, stoppedIds } };
  } else if (payload.agent_id) {
    // Every other event fired inside a subagent's own context (agent_id is set
    // only there) must touch neither the dot nor the bookkeeping: a subagent's
    // UserPromptSubmit would wipe the in-flight count, its Stop would fake the
    // main agent stopping, and its tool activity says nothing about the session.
    return { state: null, tracking };
  } else if (ev === 'UserPromptSubmit') {
    // A fresh user turn clears stale bookkeeping so a prior turn's counts (e.g.
    // an orphaned subagent stop we never saw) can't leak into this one.
    subagents = 0; mainStopped = false; stoppedIds = [];
  } else if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    // Main-thread tool activity means the main agent is running (again) — e.g.
    // re-invoked to process a finished background task — so a subagent stop
    // arriving mid-work must not settle the session out from under it.
    if (spawnsSubagent(payload)) subagents += 1;
    mainStopped = false;
  } else if (ev === 'Stop') {
    mainStopped = true;
  }

  const next = { subagents, mainStopped, stoppedIds };

  // A stop (main or subagent) settles the session to `completed` only once the
  // main agent has stopped AND no subagents remain; until then it's still working
  // (through its remaining agents), which also withholds the completion chime.
  if (subagentStopped || ev === 'Stop') {
    return { state: mainStopped && subagents === 0 ? 'completed' : 'working', tracking: next };
  }
  return { state: eventToState(payload), tracking: next };
}

// A bare ESC (`\x1b`) or Ctrl+C (`\x03`) typed into a *working* session interrupts
// the in-flight agent turn. Claude Code emits no hook for this, so we read it off
// the raw PTY input instead. Only a session that's actually working can be
// interrupted — the same bytes mean other things (closing a menu, etc.) in any
// other state — and arrow/function keys arrive as multi-byte escape sequences
// (`\x1b[…`), so an exact match never catches them. Returns the new state, or null
// to leave the dot unchanged.
function interruptState(data, current) {
  if (current !== 'working') return null;
  return data === '\x1b' || data === '\x03' ? 'interrupted' : null;
}

// Whether a derived state should overwrite the current one. Resuming a saved
// session fires SessionStart -> idle, which must NOT wipe the meaningful colour
// (completed/pushed/interrupted) it was reopened with — so reject an idle that
// would downgrade an already-meaningful state. A brand-new session is already
// idle, so it is unaffected; any non-idle state always applies.
function shouldApplyState(next, current) {
  return !(next === 'idle' && current && current !== 'idle');
}

// The `claude --settings <json>` payload that wires every hook event to POST its
// raw stdin to our local server on `port`. One command for all events keeps this
// trivial; events Claude Code doesn't recognise simply never fire. When a
// `statusLineCommand` is given it's injected as the session's statusLine, so the
// per-session token/cost meter rides on the same settings flag as the hooks —
// the user's global settings are still never touched.
// `ideId` tags every hook with the IDE's own session id (`?ide=`), exactly as the
// Codex hooks do. Claude is spawned with `--session-id <our uuid>`, so its
// payloads normally already carry it — but the CLI *changes* its session id
// mid-run: `/fork` (and a forked agent's own turns) continue in a brand-new
// session with a new id and a new transcript file. Those payloads then named a
// session this app has never heard of, so recordSessionActivity dropped them on
// the floor and the fork's edits, status and chat were all invisible. The URL tag
// is the one thing the CLI can't rewrite, so normalizeHookPayload can always map
// the payload back onto our session. Quoted because Claude runs hook commands
// through the platform shell.
function hooksSettings(port, statusLineCommand, ideId) {
  const url = `http://127.0.0.1:${port}/hook${ideId ? `?ide=${ideId}` : ''}`;
  const cmd = `curl -s -X POST "${url}" -d @-`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }];
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'SubagentStop'];
  const hooks = {};
  for (const e of events) hooks[e] = entry;
  // Turn off agent view in every spawned session: this app already manages
  // sessions side by side, so Claude Code's own background-agent screen (opened
  // with `claude agents`) is redundant here. There is no CLI flag for it — the
  // only toggles are the `disableAgentView` setting and the
  // CLAUDE_CODE_DISABLE_AGENT_VIEW env var — so we set it on the same per-session
  // settings blob, leaving the user's global settings untouched.
  const settings = { hooks, disableAgentView: true };
  // padding: 0 removes Claude's own side padding so $COLUMNS matches the usable
  // width and the right-aligned cost reaches the edge without being clipped.
  if (statusLineCommand) settings.statusLine = { type: 'command', command: statusLineCommand, padding: 0 };
  return JSON.stringify(settings);
}

// Map a hook payload onto the IDE's own session id. Every hook URL carries ours
// as `?ide=<id>`, and this rewrite makes the payload speak our id everywhere
// downstream (status, tracking, chat) whenever the CLI's own id differs — Codex
// invents its session UUID (it has no --session-id), and Claude *replaces* the
// one we gave it whenever the conversation forks (`/fork`). Without the rewrite
// those payloads name a session the app doesn't know and are dropped entirely.
// The CLI's own id is returned as `agentSessionId`: it's what `codex resume`
// needs later, and for Claude it's the id of the conversation actually running.
// Payloads that already match pass through untouched.
function normalizeHookPayload(payload, ideId) {
  if (!ideId || !payload || payload.session_id === ideId) return { payload, agentSessionId: '' };
  return { payload: { ...payload, session_id: ideId }, agentSessionId: String(payload.session_id || '') };
}

module.exports = { eventToState, deriveStatus, interruptState, shouldApplyState, hooksSettings, normalizeHookPayload };
