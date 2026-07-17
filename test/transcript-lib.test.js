const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, feed, parseTranscript, toolTitle, userText } = require('../src/main/transcript-lib');

const line = (o) => JSON.stringify(o) + '\n';
const user = (text, extra = {}) => line({ type: 'user', uuid: 'u1', timestamp: 't', message: { role: 'user', content: text }, ...extra });
const assistant = (content, extra = {}) => line({ type: 'assistant', uuid: 'a1', timestamp: 't', message: { role: 'assistant', content }, ...extra });

test('feed: a user turn and an assistant reply become chat messages', () => {
  const st = createState();
  const changed = feed(st, user('fix the build') + assistant([{ type: 'text', text: 'On it.' }]));
  assert.equal(changed.length, 2);
  assert.deepEqual(st.msgs.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(st.msgs[0].blocks, [{ t: 'text', text: 'fix the build' }]);
  assert.deepEqual(st.msgs[1].blocks, [{ t: 'text', text: 'On it.' }]);
});

test('feed: a tool result patches the message carrying the call, not a new one', () => {
  const st = createState();
  feed(st, assistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/repo/a.js' } }], { cwd: '/repo' }));
  const call = st.msgs[0].blocks[0];
  assert.deepEqual({ t: call.t, name: call.name, title: call.title, status: call.status }, { t: 'tool', name: 'Read', title: 'a.js', status: 'running' });

  const changed = feed(st, line({
    type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }] },
  }));
  assert.equal(st.msgs.length, 1, 'the result is not a turn of its own');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].uuid, st.msgs[0].uuid, 'it re-emits the message it patched');
  assert.equal(st.msgs[0].blocks[0].status, 'ok');
  assert.equal(st.msgs[0].blocks[0].output, 'file body');
});

test('feed: an errored tool result is marked as one', () => {
  const st = createState();
  feed(st, assistant([{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } }]));
  feed(st, line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } }));
  assert.equal(st.msgs[0].blocks[0].status, 'error');
  assert.equal(st.msgs[0].blocks[0].output, 'boom');
});

test('feed: an edit result attaches the CLI structuredPatch as a diff with real line numbers', () => {
  const st = createState();
  feed(st, assistant([{ type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: '/repo/relay-client.js' } }], { cwd: '/repo' }));
  feed(st, line({
    type: 'user', uuid: 'u2',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    toolUseResult: {
      structuredPatch: [{ oldStart: 42, newStart: 42, lines: ['-this.retry = 1', '+if (!this.closed)', '+this.retry = 1'] }],
    },
  }));
  const block = st.msgs[0].blocks[0];
  assert.equal(block.status, 'ok');
  assert.deepEqual(block.diff, {
    added: 2, removed: 1,
    lines: [
      { n: 42, sign: '-', text: 'this.retry = 1' },
      { n: 42, sign: '+', text: 'if (!this.closed)' },
      { n: 43, sign: '+', text: 'this.retry = 1' },
    ],
  });
});

test('feed: an Edit call shows its removed/added code before any result arrives', () => {
  const st = createState();
  feed(st, assistant([{
    type: 'tool_use', id: 'tu_1', name: 'Edit',
    input: { file_path: '/repo/a.js', old_string: 'a\nb', new_string: 'c' },
  }], { cwd: '/repo' }));
  assert.deepEqual(st.msgs[0].blocks[0].diff, {
    added: 1, removed: 2,
    lines: [
      { n: 0, sign: '-', text: 'a' },
      { n: 0, sign: '-', text: 'b' },
      { n: 0, sign: '+', text: 'c' },
    ],
  });
});

test('feed: a Write call is all additions; a Read call carries no diff', () => {
  const st = createState();
  feed(st, assistant([
    { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/repo/a.js', content: 'one\ntwo' } },
    { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/repo/a.js' } },
  ]));
  const [write, read] = st.msgs[0].blocks;
  assert.deepEqual(write.diff, { added: 2, removed: 0, lines: [{ n: 0, sign: '+', text: 'one' }, { n: 0, sign: '+', text: 'two' }] });
  assert.equal(read.diff, undefined);
});

test('feed: a result without a patch leaves the tool block diff-free', () => {
  const st = createState();
  feed(st, assistant([{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }]));
  feed(st, line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'body' }] }, toolUseResult: { structuredPatch: [] } }));
  assert.equal(st.msgs[0].blocks[0].diff, undefined);
});

test('feed: a line torn across two reads is parsed once it is whole', () => {
  const st = createState();
  const whole = user('hello');
  assert.deepEqual(feed(st, whole.slice(0, 12)), [], 'a partial line yields nothing');
  const changed = feed(st, whole.slice(12));
  assert.equal(changed.length, 1);
  assert.deepEqual(st.msgs[0].blocks, [{ t: 'text', text: 'hello' }]);
});

test('feed: subagent, meta and unparsable lines are skipped', () => {
  const st = createState();
  feed(st, user('side', { isSidechain: true }) + user('meta', { isMeta: true }) + '{ not json\n' + line({ type: 'summary' }));
  assert.deepEqual(st.msgs, []);
});

test('feed: images are reduced to a marker, never the inlined base64', () => {
  const st = createState();
  feed(st, line({
    type: 'user', uuid: 'u1',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'text', text: 'what is this' }] },
  }));
  assert.deepEqual(st.msgs[0].blocks, [{ t: 'image' }, { t: 'text', text: 'what is this' }]);
});

test('userText: a slash command reads as the line the user typed', () => {
  assert.equal(userText('<command-message>init</command-message><command-name>/init</command-name>'), '/init');
  assert.equal(userText('<command-name>/model</command-name><command-args>opus</command-args>'), '/model opus');
});

test('userText: the CLI machinery wrapped around a turn is not conversation', () => {
  assert.equal(userText('<system-reminder>be good</system-reminder>real question'), 'real question');
  assert.equal(userText('<local-command-stdout>output</local-command-stdout>'), '');
});

test('toolTitle: each tool is summarized by the thing it acts on', () => {
  assert.equal(toolTitle('Read', { file_path: '/repo/src/a.js' }, '/repo'), 'src/a.js');
  assert.equal(toolTitle('Read', { file_path: '/elsewhere/a.js' }, '/repo'), '/elsewhere/a.js');
  assert.equal(toolTitle('Bash', { command: 'npm test\n--watch' }), 'npm test');
  assert.equal(toolTitle('Task', { description: 'find the bug' }), 'find the bug');
  assert.equal(toolTitle('TodoWrite', { todos: [1, 2, 3] }), '3 items');
});

test('parseTranscript: reads a whole file, tolerating a missing trailing newline', () => {
  const msgs = parseTranscript(user('one') + assistant([{ type: 'text', text: 'two' }]).trimEnd());
  assert.deepEqual(msgs.map((m) => m.blocks[0].text), ['one', 'two']);
});

test('feed: the window is bounded, and a dropped message stops being patchable', () => {
  const st = createState();
  feed(st, assistant([{ type: 'tool_use', id: 'tu_old', name: 'Read', input: {} }], { uuid: 'old' }));
  let bulk = '';
  for (let i = 0; i < 420; i++) bulk += line({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `m${i}` } });
  feed(st, bulk);
  assert.equal(st.msgs.length, 400);
  assert.equal(st.msgs.find((m) => m.uuid === 'old'), undefined);
  assert.deepEqual(
    feed(st, line({ type: 'user', uuid: 'r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_old', content: 'x' }] } })),
    [], 'a result for an evicted call patches nothing and adds nothing',
  );
});

// --- Codex rollout format (dispatched by shape; see applyCodexEntry) ---------

function codexLines() {
  return [
    { timestamp: 't0', type: 'session_meta', payload: { session_id: 'cx-1' } },
    { timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: 'Create spike.txt' } },
    // machinery user message: must not become a chat turn
    { timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan the file write' }], encrypted_content: 'xxx' } },
    { timestamp: 't3', type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'shell_command', arguments: '{"command":"Set-Content spike.txt hello"}', call_id: 'call_1' } },
    { timestamp: 't4', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Exit code: 0\nOutput:\n' } },
    { timestamp: 't5', type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Created spike.txt.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
}

test('codex rollout: user turn, thinking summary, tool call + result, reply', () => {
  const msgs = parseTranscript(codexLines());
  assert.deepEqual(msgs.map((m) => [m.role, m.blocks[0].t]), [
    ['user', 'text'], ['assistant', 'thinking'], ['assistant', 'tool'], ['assistant', 'text'],
  ]);
  assert.equal(msgs[0].blocks[0].text, 'Create spike.txt');
  assert.equal(msgs[1].blocks[0].text, 'Plan the file write');
  const tool = msgs[2].blocks[0];
  assert.equal(tool.name, 'shell_command');
  assert.equal(tool.title, 'Set-Content spike.txt hello');
  assert.equal(tool.status, 'ok');
  assert.match(tool.output, /Exit code: 0/);
  assert.equal(msgs[3].blocks[0].text, 'Created spike.txt.');
});

test('codex rollout: a failing tool is marked as an error', () => {
  const state = createState();
  feed(state, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":["git","status"]}', call_id: 'c9' } }) + '\n');
  feed(state, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c9', output: 'Exit code: 128\nfatal: not a repo' } }) + '\n');
  const tool = state.msgs[0].blocks[0];
  assert.equal(tool.title, 'git status'); // argv-array command joined
  assert.equal(tool.status, 'error');
});

test('codex rollout lines never leak into the claude parser and vice versa', () => {
  const state = createState();
  // A claude entry still parses after codex entries fed the same state.
  feed(state, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }) + '\n');
  const out = feed(state, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi from claude' } }) + '\n');
  assert.equal(out.length, 1);
  assert.equal(out[0].blocks[0].text, 'hi from claude');
});
