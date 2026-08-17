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

// The conversation a payload belongs to when the CLI reports no id of its own —
// i.e. an ordinary Claude session still running under the id we spawned it with.
const MAIN_ORIGIN = 'main';
// A conversation that hasn't fired a single hook in this long is not running.
// Every tool call refreshes its stamp, so only a truly abandoned origin ages out
// — which is the escape hatch for the one shape we can't observe directly: a
// `/fork` that *replaces* the conversation (the old id simply stops existing and
// never fires its `Stop`), as opposed to one that runs alongside it.
const ORIGIN_STALE_MS = 5 * 60 * 1000;

// Layer agent-aware gating over eventToState so the finish chime waits for the
// LAST agent in a session, not the first. Two different things can outlive the
// main agent's turn, and both must hold the session yellow:
//
//  - **Subagents** (`Task`/`Agent` tool spawns, Codex `SubagentStart`). They run
//    inside the session and announce themselves with `agent_id`, so they're
//    counted: spawns against subagent stops.
//  - **Forked conversations** (`/fork`). These are not subagents at all — the CLI
//    runs each one as a *separate conversation with its own session_id*, so their
//    hooks carry no `agent_id` and, once `normalizeHookPayload` maps them back
//    onto our session, a fork's `Stop` looked exactly like the main agent
//    finishing. That's why a session with forks still working went green: the
//    first `Stop` from any of them settled the whole session. So instead of one
//    `mainStopped` boolean we track the *set of conversation ids currently in
//    flight* (`active`), keyed by the CLI's own session id (`opts.originId`,
//    which the hook server takes from normalizeHookPayload). Each conversation's
//    activity adds it, each conversation's `Stop` removes only itself.
//
// `tracking` is the caller-held per-session bookkeeping
// { subagents, active: [{id, at}], stoppedIds }. `opts` is { originId, now }.
// deriveStatus returns the state to apply (or null to leave the dot unchanged)
// alongside the next tracking. Pure and unit-tested (test/hook-events.test.js).
function deriveStatus(payload, tracking = {}, opts = {}) {
  const origin = opts.originId || MAIN_ORIGIN;
  const now = opts.now || 0;
  let subagents = tracking.subagents || 0;
  // Whether any conversation in this session has reported a `Stop` this turn. An
  // empty in-flight set means "nothing running" both before the first event and
  // after the last stop, so this is what tells the two apart — without it a stray
  // subagent stop arriving before any work would settle the session.
  let stopped = Boolean(tracking.stopped);
  // `now` of 0 means the caller isn't supplying a clock (tests, mostly) — then
  // nothing ages out and the set is driven purely by stops.
  let active = (tracking.active || []).filter((a) => !now || now - a.at < ORIGIN_STALE_MS);
  const touchOrigin = () => { active = [...active.filter((a) => a.id !== origin), { id: origin, at: now }]; };
  const dropOrigin = () => { active = active.filter((a) => a.id !== origin); };
  // Agent ids already counted as stopped this turn. A finishing subagent can
  // announce itself twice — a `SubagentStop` AND a mis-routed `Stop`, both with
  // its agent_id — and counting both drains the in-flight count for two agents,
  // settling the session (and ringing the chime) while another background agent
  // is still running. Only the first stop per agent_id may decrement.
  let stoppedIds = tracking.stoppedIds || [];
  // Background agents we know are alive because we've *seen* them: any event
  // carrying an `agent_id`. Counting spawns alone misses everything the main
  // thread never announced with a `Task`/`Agent` PreToolUse — above all a `/fork`,
  // which the CLI starts as a slash command and then runs as its own agent
  // context. Those forks fired nothing but agent_id events, every one of which hit
  // the early-return below, so the count stayed 0 and a session with a fork still
  // working sat flat green. Stamped like `active` so an agent that dies without a
  // stop ages out instead of spinning forever.
  let agents = (tracking.agents || []).filter((a) => !now || now - a.at < ORIGIN_STALE_MS);
  const ev = payload.hook_event_name;
  const subagentStopped = isSubagentStop(payload);
  // Set for an event fired inside an agent's own context: it updates the
  // bookkeeping but never maps to a state of its own.
  let agentContext = false;

  if (subagentStopped) {
    const id = payload.agent_id;
    if (id && stoppedIds.includes(id)) {
      // Duplicate stop for an agent already drained — ignore entirely.
      return { state: null, tracking };
    }
    // An agent we'd already seen claimed its spawn slot when it first appeared, so
    // it only leaves `agents`; one we never saw drains the unmatched-spawn count.
    if (id && agents.some((a) => a.id === id)) {
      stoppedIds = [...stoppedIds, id];
      agents = agents.filter((a) => a.id !== id);
    } else {
      if (id) stoppedIds = [...stoppedIds, id];
      subagents = Math.max(0, subagents - 1);
    }
    // Deliberately no touchOrigin(): a subagent finishing says nothing about
    // whether its parent conversation is still running.
  } else if (ev === 'SubagentStart') {
    // Codex announces a subagent spawning as its own event (Claude signals it via
    // the Task/Agent PreToolUse below). Counted before the agent_id early-return
    // so the count balances its SubagentStop regardless of which context Codex
    // fires it from; a spawn also proves the main agent is running.
    subagents += 1;
    touchOrigin();
    return { state: 'working', tracking: { subagents, agents, active, stopped, stoppedIds } };
  } else if (payload.agent_id) {
    // An event from inside an agent's own context. It must not drive the dot the
    // way a main-thread event does — its UserPromptSubmit would wipe the in-flight
    // count, its Stop would fake the main agent stopping, its tool activity says
    // nothing about what the chat is doing. But it *does* prove that agent is
    // alive, which is the one thing the spawn count can't tell us about an agent
    // the main thread never announced (a `/fork`). So: register it, touch nothing
    // else. A first sighting claims an unmatched spawn slot if one is open, so a
    // `Task` subagent counted at PreToolUse isn't counted twice.
    const id = payload.agent_id;
    if (!stoppedIds.includes(id)) {
      if (agents.some((a) => a.id === id)) {
        agents = agents.map((a) => (a.id === id ? { id, at: now } : a));
      } else {
        if (subagents > 0) subagents -= 1;
        agents = [...agents, { id, at: now }];
      }
    }
    agentContext = true;
  } else if (ev === 'UserPromptSubmit') {
    // A fresh user turn clears stale bookkeeping so a prior turn's counts (e.g.
    // an orphaned subagent stop we never saw) can't leak into this one — but only
    // when nothing is in flight. A fork prompting itself mid-run is not a fresh
    // turn for the session, and wiping the counts there is what would settle it
    // while its siblings are still working.
    // Only the *main* conversation starting a turn is a fresh turn for the session.
    // A fork's own prompt must not clear `stopped` either: that flag is what says
    // the chat is free, and wiping it is what made a fork's background work read as
    // the main agent being busy (yellow) instead of the green spinner.
    if (!active.length && origin === MAIN_ORIGIN) {
      subagents = 0; agents = []; stoppedIds = []; stopped = false;
    }
    touchOrigin();
  } else if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    // Tool activity means this conversation is running (again) — e.g. a main
    // agent re-invoked to process a finished background task — so a stop
    // arriving mid-work must not settle the session out from under it.
    if (spawnsSubagent(payload)) subagents += 1;
    touchOrigin();
  } else if (ev === 'Stop') {
    // Only the conversation that stopped leaves the in-flight set; a fork's Stop
    // must not stand in for the main agent's (or another fork's).
    dropOrigin();
    stopped = true;
  }

  const next = { subagents, agents, active, stopped, stoppedIds };
  // Every background agent in flight: ones counted from a spawn we saw, plus ones
  // we only know about because they've been firing events of their own.
  const inFlight = subagents + agents.length;

  // Whether the *main* conversation — the one the user types into — is itself
  // running. That's what the dot's colour answers: yellow means "the chat is busy,
  // you can't send anything", green means "it's yours". Background work (subagents,
  // and forks, which `/fork` runs as their own conversations) doesn't block the
  // chat, so it can't turn the dot yellow — it only keeps it *spinning*.
  const mainBusy = active.some((a) => a.id === MAIN_ORIGIN);
  // Work of any kind is still in flight, but not in the main conversation.
  const backgroundOnly = stopped && !mainBusy && (active.length > 0 || inFlight > 0);

  // An agent-context event never paints the chat, but it can reveal that background
  // work is running under a chat that already settled — which is exactly the green
  // spinner. Without this a `/fork` would leave the dot flat green until it stopped.
  if (agentContext) return { state: backgroundOnly ? 'bg-agents' : null, tracking: next };

  // A stop (conversation or subagent) settles the session to `completed` only once
  // every conversation has stopped AND no subagents remain; until then something is
  // still running, and which state that is depends only on whether the *main* chat
  // is the thing running.
  if (subagentStopped || ev === 'Stop') {
    if (backgroundOnly) return { state: 'bg-agents', tracking: next };
    if (!stopped || active.length || inFlight > 0) return { state: 'working', tracking: next };
    return { state: 'completed', tracking: next };
  }
  // A background conversation's own activity mustn't paint the chat yellow either:
  // a fork churning away after the main agent stopped leaves the chat free, so it
  // reads as the green spinner. Its blocking asks (needs-input) still come through
  // — those are addressed to the user and outrank "merely running".
  const state = eventToState(payload);
  if (state === 'working' && backgroundOnly) return { state: 'bg-agents', tracking: next };
  return { state, tracking: next };
}

// A bare ESC (`\x1b`) or Ctrl+C (`\x03`) typed into a *working* session is a
// *candidate* interrupt of the in-flight turn — not proof of one. The keystroke is
// only ever a request: the TUI may swallow it (dismissing its own overlay,
// clearing a half-typed prompt, a stray keypress while our dot is merely stale),
// and the agent then keeps working while the dot has already gone red. So this
// answers "is the user asking to interrupt", and the hook stream — the trusted
// source — decides whether one actually happened (see interruptOutcome).
//
// Only a session that's currently working can be interrupted, the same bytes mean
// other things in any other state, and arrow/function keys arrive as multi-byte
// escape sequences (`\x1b[…`) so an exact match never catches them.
function isInterruptKey(data, current) {
  return current === 'working' && (data === '\x1b' || data === '\x03');
}

// Arbitrate a pending keystroke interrupt against the next hook event from the
// session — the only account of what the agent is really doing.
//
//  - The turn ending right after the keystroke (`derived === 'completed'`) is the
//    interrupt landing: the same event a natural finish produces, but here it was
//    cut short, so it's red, not green — and no completion chime.
//  - Any other event proves the agent kept running (a tool call, a new prompt, a
//    permission ask), so the keystroke meant something else and the derived state
//    stands untouched.
//
// Either way the pending interrupt is resolved; the caller drops it.
function interruptOutcome(derived) {
  return derived === 'completed' ? 'interrupted' : derived;
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

module.exports = {
  eventToState, deriveStatus, isInterruptKey, interruptOutcome, shouldApplyState,
  hooksSettings, normalizeHookPayload, ORIGIN_STALE_MS,
};
