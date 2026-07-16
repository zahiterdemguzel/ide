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
