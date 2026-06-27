// Pure (Electron-free) hook logic for the status dots: the event -> state mapping,
// the resume-downgrade rule, and the per-session settings JSON. The http server,
// sessions/IPC glue, and the live hookPort live in hook-server.js. Kept here so
// this — the heart of docs/status-detection.md — stays unit-tested
// (test/hook-events.test.js).

// Map a Claude Code hook payload to a session status, or null to leave it
// unchanged. PostToolUse sniffs the command for a `git push` so the dot can flip
// to "pushed"; everything else maps by event name.
function eventToState(payload) {
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
// trivial; events Claude Code doesn't recognise simply never fire.
function hooksSettings(port) {
  const cmd = `curl -s -X POST http://127.0.0.1:${port}/hook -d @-`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }];
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop'];
  const hooks = {};
  for (const e of events) hooks[e] = entry;
  return JSON.stringify({ hooks });
}

module.exports = { eventToState, shouldApplyState, hooksSettings };
