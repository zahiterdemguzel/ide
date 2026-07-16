const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHistory, buildFunctions, buildGenOptions, toToolCalls, doneReason,
  looksLikeToolCallStart, salvageToolCall,
} = require('../src/main/llama-engine-lib');

test('buildHistory: plain turns map to system/user/model and get a trailing model slot', () => {
  const h = buildHistory([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(h, [
    { type: 'system', text: 'be brief' },
    { type: 'user', text: 'hi' },
    { type: 'model', response: [] },
  ]);
});

test('buildHistory: assistant tool_calls fold in the following tool results', () => {
  const h = buildHistory([
    { role: 'user', content: 'read a.txt' },
    {
      role: 'assistant',
      content: 'sure',
      tool_calls: [
        { function: { name: 'read', arguments: { path: 'a.txt' } } },
        { function: { name: 'read', arguments: { path: 'b.txt' } } },
      ],
    },
    { role: 'tool', content: 'AAA' },
    { role: 'tool', content: 'BBB' },
  ]);
  // The two tool results pair with the two calls inside one model turn...
  assert.deepEqual(h[1], {
    type: 'model',
    response: [
      'sure',
      { type: 'functionCall', name: 'read', params: { path: 'a.txt' }, result: 'AAA' },
      { type: 'functionCall', name: 'read', params: { path: 'b.txt' }, result: 'BBB' },
    ],
  });
  // ...and since history already ends on a model turn, no extra empty slot is added.
  assert.equal(h.length, 2);
  assert.equal(h[h.length - 1].type, 'model');
});

test('buildHistory: a missing tool result leaves an empty-string result, not a crash', () => {
  const h = buildHistory([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: {} } }] },
  ]);
  assert.deepEqual(h[1].response, [{ type: 'functionCall', name: 'x', params: {}, result: '' }]);
});

test('buildHistory: empty input still yields a generatable model slot', () => {
  assert.deepEqual(buildHistory([]), [{ type: 'model', response: [] }]);
  assert.deepEqual(buildHistory(undefined), [{ type: 'model', response: [] }]);
});

test('buildFunctions: maps tool defs and returns undefined when there are none', () => {
  assert.equal(buildFunctions([]), undefined);
  assert.equal(buildFunctions(undefined), undefined);
  const fns = buildFunctions([
    { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } },
    { type: 'function', function: { description: 'no name -> skipped' } },
  ]);
  assert.deepEqual(Object.keys(fns), ['grep']);
  assert.equal(fns.grep.description, 'search');
  assert.deepEqual(fns.grep.params, { type: 'object', properties: { q: { type: 'string' } } });
});

test('buildGenOptions: maps ollama options to LlamaChat option names', () => {
  assert.deepEqual(
    buildGenOptions({ temperature: 0.2, top_p: 0.9, num_predict: 256, stop: ['\n\n'] }),
    { temperature: 0.2, topP: 0.9, maxTokens: 256, customStopTriggers: ['\n\n'] },
  );
  // num_predict of 0/negative is dropped (llama.cpp treats maxTokens<=0 oddly).
  assert.deepEqual(buildGenOptions({ num_predict: 0 }), {});
  assert.deepEqual(buildGenOptions(undefined), {});
});

test('looksLikeToolCallStart: only JSON/fence/tool_call leads', () => {
  assert.ok(looksLikeToolCallStart('{"name":"x"}'));
  assert.ok(looksLikeToolCallStart('   ```json\n{'));
  assert.ok(looksLikeToolCallStart('<tool_call>{'));
  assert.ok(!looksLikeToolCallStart('Hello there!'));
  assert.ok(!looksLikeToolCallStart('Sure, here is `code`'));
  assert.ok(!looksLikeToolCallStart(''));
});

test('salvageToolCall: recovers a fenced/bare/wrapped JSON call for a known tool', () => {
  const names = ['Edit', 'Read'];
  assert.deepEqual(
    salvageToolCall('```json\n{"name":"Edit","arguments":{"path":"a.txt"}}\n```', names),
    [{ function: { name: 'Edit', arguments: { path: 'a.txt' } } }],
  );
  assert.deepEqual(
    salvageToolCall('{"name":"Read","arguments":{}}', names),
    [{ function: { name: 'Read', arguments: {} } }],
  );
  // a no-arguments call is valid
  assert.deepEqual(salvageToolCall('{"name":"Read"}', names), [{ function: { name: 'Read', arguments: {} } }]);
  assert.deepEqual(
    salvageToolCall('<tool_call>{"name":"Edit","arguments":{"x":1}}</tool_call>', names),
    [{ function: { name: 'Edit', arguments: { x: 1 } } }],
  );
});

test('salvageToolCall: extracts a call buried in prose (the real weak-model case)', () => {
  const names = ['Glob', 'Read'];
  const reply = 'Great! Here\'s how you can use the Glob tool:\n\n{\n  "name": "Glob",\n  "arguments": { "pattern": "**/styles/**/*.css" }\n}\n\nThis will find the files.';
  assert.deepEqual(
    salvageToolCall(reply, names),
    [{ function: { name: 'Glob', arguments: { pattern: '**/styles/**/*.css' } } }],
  );
  // braces inside a JSON string don't break the balanced-object scan
  assert.deepEqual(
    salvageToolCall('do this: {"name":"Read","arguments":{"path":"a{b}.txt"}} ok', names),
    [{ function: { name: 'Read', arguments: { path: 'a{b}.txt' } } }],
  );
});

test('salvageToolCall: refuses unknown tools and non-calls', () => {
  const names = ['Edit'];
  assert.equal(salvageToolCall('Sure! {"name":"Nope","arguments":{}} done', names), null); // unknown tool
  assert.equal(salvageToolCall('here is data {"foo":"bar"}', names), null); // no name
  assert.equal(salvageToolCall('{"name":"Edit","arguments":[1,2]}', names), null); // args not an object
  assert.equal(salvageToolCall('just a normal answer', names), null);
  assert.equal(salvageToolCall('{"name":"Edit"}', []), null); // no tools offered
  assert.equal(salvageToolCall('not json', names), null);
});

test('toToolCalls / doneReason', () => {
  assert.deepEqual(
    toToolCalls([{ functionName: 'read', params: { p: 1 } }, { functionName: 'ls', params: null }]),
    [{ function: { name: 'read', arguments: { p: 1 } } }, { function: { name: 'ls', arguments: {} } }],
  );
  assert.deepEqual(toToolCalls(undefined), []);
  assert.equal(doneReason('maxTokens'), 'length');
  assert.equal(doneReason('eogToken'), 'stop');
  assert.equal(doneReason(undefined), 'stop');
});
