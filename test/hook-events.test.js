const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventToState, interruptState, shouldApplyState, hooksSettings } = require('../src/main/hook-events');

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
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop'];
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
