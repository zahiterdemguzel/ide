const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventToState, deriveStatus, interruptState, shouldApplyState, hooksSettings } = require('../src/main/hook-events');

test('eventToState: Stop -> completed', () => {
  assert.equal(eventToState({ hook_event_name: 'Stop' }), 'completed');
});

test('eventToState: Notification and PermissionRequest -> needs-input', () => {
  assert.equal(eventToState({ hook_event_name: 'Notification' }), 'needs-input');
  assert.equal(eventToState({ hook_event_name: 'PermissionRequest' }), 'needs-input');
});

test('eventToState: SessionStart -> idle (gray until first prompt)', () => {
  assert.equal(eventToState({ hook_event_name: 'SessionStart' }), 'idle');
});

test('eventToState: UserPromptSubmit and PreToolUse -> working', () => {
  assert.equal(eventToState({ hook_event_name: 'UserPromptSubmit' }), 'working');
  assert.equal(eventToState({ hook_event_name: 'PreToolUse' }), 'working');
});

test('eventToState: PostToolUse without a command -> working', () => {
  assert.equal(eventToState({ hook_event_name: 'PostToolUse' }), 'working');
  assert.equal(eventToState({ hook_event_name: 'PostToolUse', tool_input: {} }), 'working');
});

test('eventToState: PostToolUse running git push -> pushed', () => {
  assert.equal(
    eventToState({ hook_event_name: 'PostToolUse', tool_input: { command: 'git push origin master' } }),
    'pushed',
  );
  // tolerant of extra whitespace between git and push
  assert.equal(
    eventToState({ hook_event_name: 'PostToolUse', tool_input: { command: 'git   push' } }),
    'pushed',
  );
});

test('eventToState: a non-push command on PostToolUse stays working', () => {
  assert.equal(
    eventToState({ hook_event_name: 'PostToolUse', tool_input: { command: 'git pull' } }),
    'working',
  );
  // "push" inside an unrelated word is not a git push
  assert.equal(
    eventToState({ hook_event_name: 'PostToolUse', tool_input: { command: 'echo pushup' } }),
    'working',
  );
});

test('eventToState: unknown / missing events map to null (left unchanged)', () => {
  assert.equal(eventToState({ hook_event_name: 'SomethingElse' }), null);
  assert.equal(eventToState({}), null);
});

test('eventToState: any event carrying agent_id (a Task-tool subagent context) is ignored', () => {
  // agent_id is only present when the hook fires inside a subagent's own
  // context, never for the main thread's Task tool call itself.
  assert.equal(eventToState({ hook_event_name: 'Stop', agent_id: 'sub-1' }), null);
  assert.equal(eventToState({ hook_event_name: 'UserPromptSubmit', agent_id: 'sub-1' }), null);
  assert.equal(eventToState({ hook_event_name: 'PreToolUse', agent_id: 'sub-1' }), null);
  assert.equal(
    eventToState({ hook_event_name: 'PostToolUse', agent_id: 'sub-1', tool_input: { command: 'git push' } }),
    null,
  );
});

// deriveStatus: subagent-aware gating of the completed state / finish chime.
// Threads its returned tracking through a sequence of events like the hook server.
function runEvents(payloads) {
  let tracking = { subagents: 0, mainStopped: false };
  const states = [];
  for (const p of payloads) {
    const r = deriveStatus(p, tracking);
    tracking = r.tracking;
    states.push(r.state);
  }
  return { states, tracking };
}

test('deriveStatus: no subagents — main Stop completes immediately (unchanged behavior)', () => {
  const { states } = runEvents([
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit' },
    { hook_event_name: 'Stop' },
  ]);
  assert.deepEqual(states, ['working', 'working', 'completed']);
});

test('deriveStatus: a blocking subagent that finishes before main still completes on Stop', () => {
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'SubagentStop' },
    { hook_event_name: 'Stop' },
  ]);
  // SubagentStop before main Stop keeps it working; the final Stop completes it.
  assert.deepEqual(states, ['working', 'working', 'completed']);
});

test('deriveStatus: a background subagent outliving main Stop holds completed until it finishes', () => {
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop' }, // main done, subagent still running
    { hook_event_name: 'SubagentStop' }, // last agent finishes -> now complete
  ]);
  assert.deepEqual(states, ['working', 'working', 'completed']);
});

test('deriveStatus: completed fires only once the LAST of several subagents finishes', () => {
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'SubagentStop' },
    { hook_event_name: 'SubagentStop' },
  ]);
  assert.deepEqual(states, ['working', 'working', 'working', 'working', 'completed']);
});

test('deriveStatus: a new user turn resets stale subagent bookkeeping', () => {
  const { tracking } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop' }, // held (subagent still counted)
    { hook_event_name: 'UserPromptSubmit' }, // fresh turn wipes the orphaned count
  ]);
  assert.deepEqual(tracking, { subagents: 0, mainStopped: false });
});

test('deriveStatus: a stray SubagentStop never drives the count negative', () => {
  const { states, tracking } = runEvents([
    { hook_event_name: 'SubagentStop' },
    { hook_event_name: 'Stop' },
  ]);
  assert.equal(tracking.subagents, 0);
  assert.deepEqual(states, ['working', 'completed']);
});

test('deriveStatus: newer CLIs name the spawning tool Agent — counted like Task', () => {
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Agent' },
    { hook_event_name: 'Stop' }, // main done, subagent still running -> held
    { hook_event_name: 'SubagentStop' },
  ]);
  assert.deepEqual(states, ['working', 'working', 'completed']);
});

test('deriveStatus: a subagent Stop (agent_id) is a subagent finishing, never the main agent', () => {
  // Some CLI versions mis-route a subagent's own stop as `Stop` (with agent_id)
  // instead of `SubagentStop`. It must decrement the in-flight count — NOT set
  // mainStopped and chime while the main agent is still working.
  const { states } = runEvents([
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop', agent_id: 'sub-1' }, // subagent done; main still going
    { hook_event_name: 'Stop' }, // now the main agent really finishes
  ]);
  assert.deepEqual(states, ['working', 'working', 'working', 'completed']);
});

test('deriveStatus: a SubagentStop carrying agent_id still drains the count', () => {
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'SubagentStop', agent_id: 'sub-1' },
  ]);
  assert.deepEqual(states, ['working', 'working', 'completed']);
});

test('deriveStatus: subagent-context events never touch the dot or the bookkeeping', () => {
  // A subagent's own UserPromptSubmit must not wipe the in-flight count, and its
  // tool activity must not drive the session state.
  const { states, tracking } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'UserPromptSubmit', agent_id: 'sub-1' },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', agent_id: 'sub-1' },
    { hook_event_name: 'PostToolUse', tool_input: { command: 'git push' }, agent_id: 'sub-1' },
    { hook_event_name: 'Notification', agent_id: 'sub-1' },
    { hook_event_name: 'Stop' }, // main done, but the subagent is still counted
  ]);
  assert.deepEqual(states, ['working', null, null, null, null, 'working']);
  assert.deepEqual(tracking, { subagents: 1, mainStopped: true });
});

test('deriveStatus: a nested spawn inside a subagent does not inflate the count', () => {
  const { tracking } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'PreToolUse', tool_name: 'Task', agent_id: 'sub-1' },
  ]);
  assert.equal(tracking.subagents, 1);
});

test('deriveStatus: main-thread activity after Stop reopens the turn', () => {
  // Main stops with two background subagents in flight; the first finishing
  // re-invokes the main agent, so the second finishing mid-work must NOT settle
  // the session — only the main agent's next Stop does.
  const { states } = runEvents([
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'PreToolUse', tool_name: 'Task' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'SubagentStop' }, // first finishes -> main re-invoked
    { hook_event_name: 'PreToolUse', tool_name: 'Read' }, // main working again
    { hook_event_name: 'SubagentStop' }, // last subagent, but main is mid-work
    { hook_event_name: 'Stop' },
  ]);
  assert.deepEqual(states,
    ['working', 'working', 'working', 'working', 'working', 'working', 'completed']);
});

test('deriveStatus: non-terminal events fall through to eventToState', () => {
  assert.equal(deriveStatus({ hook_event_name: 'Notification' }).state, 'needs-input');
  assert.equal(deriveStatus({ hook_event_name: 'SessionStart' }).state, 'idle');
  assert.equal(
    deriveStatus({ hook_event_name: 'PostToolUse', tool_input: { command: 'git push' } }).state,
    'pushed',
  );
});

test('interruptState: ESC or Ctrl+C while working -> interrupted', () => {
  assert.equal(interruptState('\x1b', 'working'), 'interrupted');
  assert.equal(interruptState('\x03', 'working'), 'interrupted');
});

test('interruptState: ESC/Ctrl+C only interrupts a working session', () => {
  for (const state of ['idle', 'needs-input', 'completed', 'pushed', 'interrupted', undefined]) {
    assert.equal(interruptState('\x1b', state), null);
    assert.equal(interruptState('\x03', state), null);
  }
});

test('interruptState: ordinary input and multi-byte escape sequences leave the dot unchanged', () => {
  assert.equal(interruptState('a', 'working'), null);
  assert.equal(interruptState('\r', 'working'), null);
  // arrow/function keys arrive as multi-byte sequences, not a bare ESC
  assert.equal(interruptState('\x1b[A', 'working'), null);
  assert.equal(interruptState('\x1b[1;5C', 'working'), null);
});

test('shouldApplyState: any non-idle state always applies', () => {
  assert.equal(shouldApplyState('working', 'completed'), true);
  assert.equal(shouldApplyState('pushed', 'idle'), true);
  assert.equal(shouldApplyState('completed', 'pushed'), true);
});

test('shouldApplyState: idle applies over no/idle current state', () => {
  assert.equal(shouldApplyState('idle', undefined), true);
  assert.equal(shouldApplyState('idle', null), true);
  assert.equal(shouldApplyState('idle', ''), true);
  assert.equal(shouldApplyState('idle', 'idle'), true);
});

test('shouldApplyState: idle does NOT downgrade a meaningful current state (resume)', () => {
  assert.equal(shouldApplyState('idle', 'completed'), false);
  assert.equal(shouldApplyState('idle', 'pushed'), false);
  assert.equal(shouldApplyState('idle', 'needs-input'), false);
  assert.equal(shouldApplyState('idle', 'working'), false);
});

test('hooksSettings: wires every tracked event to a curl POST on the given port', () => {
  const cfg = JSON.parse(hooksSettings(54321));
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop', 'SubagentStop'];
  assert.deepEqual(Object.keys(cfg.hooks).sort(), [...events].sort());
  for (const e of events) {
    const cmd = cfg.hooks[e][0].hooks[0].command;
    assert.match(cmd, /^curl -s -X POST http:\/\/127\.0\.0\.1:54321\/hook -d @-$/);
    assert.equal(cfg.hooks[e][0].matcher, '*');
    assert.equal(cfg.hooks[e][0].hooks[0].type, 'command');
  }
});

test('hooksSettings: no statusLine unless a command is supplied', () => {
  assert.equal(JSON.parse(hooksSettings(54321)).statusLine, undefined);
});

test('hooksSettings: disables agent view in every spawned session', () => {
  assert.equal(JSON.parse(hooksSettings(54321)).disableAgentView, true);
  assert.equal(JSON.parse(hooksSettings(54321, 'node "/x/statusline-script.js"')).disableAgentView, true);
});

test('hooksSettings: injects the given statusLine command with zero padding', () => {
  const cfg = JSON.parse(hooksSettings(54321, 'node "/x/statusline-script.js"'));
  assert.deepEqual(cfg.statusLine, {
    type: 'command', command: 'node "/x/statusline-script.js"', padding: 0,
  });
});
