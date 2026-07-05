// Pure (Electron-free) hook logic for the status dots: the event -> state mapping,
// the resume-downgrade rule, and the per-session settings JSON. The http server,
// sessions/IPC glue, and the live hookPort live in hook-server.js. Kept here so
// this — the heart of .claude/memory/status-detection.md — stays unit-tested
// (test/hook-events.test.js).

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
    case 'Notification':
    case 'PermissionRequest': return 'needs-input';
    case 'PostToolUse': {
      const c = payload.tool_input && payload.tool_input.command;
      if (c && /git\s+push/.test(c)) return 'pushed';
      return 'working';
    }
    // A session that has only just started has no work in flight yet — it sits
    // idle (gray) until the user submits the first prompt. Yellow ("working") is
    // reserved for an agent actively responding.
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse': return 'working';
    default: return null;
  }
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
function hooksSettings(port, statusLineCommand) {
  const cmd = `curl -s -X POST http://127.0.0.1:${port}/hook -d @-`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }];
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop'];
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

module.exports = { eventToState, interruptState, shouldApplyState, hooksSettings };
