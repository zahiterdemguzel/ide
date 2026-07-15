const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  anthropicToOllama,
  ollamaChunkToAnthropicEvents,
  ollamaDoneToStopReason,
  nonStreamToAnthropic,
} = require('../src/main/ollama-translate-lib');

test('anthropicToOllama: flattens a system text-block array into one system message', () => {
  const body = anthropicToOllama({
    model: 'llama3.1:8b',
    system: [{ type: 'text', text: 'You are Claude Code' }, { type: 'text', text: 'be terse' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(body.model, 'llama3.1:8b');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'You are Claude Code\nbe terse' });
  assert.deepEqual(body.messages[1], { role: 'user', content: 'hi' });
});

test('anthropicToOllama: maps tools to Ollama function schema', () => {
  const body = anthropicToOllama({
    messages: [],
    tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  }]);
});

test('anthropicToOllama: a tool_use block becomes assistant tool_calls', () => {
  const body = anthropicToOllama({
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'read', input: { path: 'a.txt' } }] }],
  });
  const asst = body.messages[0];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content, 'ok');
  assert.deepEqual(asst.tool_calls, [{ function: { name: 'read', arguments: { path: 'a.txt' } } }]);
});

test('anthropicToOllama: a tool_result becomes its own {role:tool} message', () => {
  const body = anthropicToOllama({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'file body' }] }] }],
  });
  assert.deepEqual(body.messages, [{ role: 'tool', content: 'file body' }]);
});

test('anthropicToOllama: max_tokens/temperature/stop go into options', () => {
  const body = anthropicToOllama({ messages: [], max_tokens: 256, temperature: 0.2, stop_sequences: ['STOP'] });
  assert.equal(body.options.temperature, 0.2);
  assert.equal(body.options.num_predict, 256);
  assert.deepEqual(body.options.stop, ['STOP']);
});

test('anthropicToOllama: always sets a large num_ctx so Claude Code’s prompt is not truncated', () => {
  // Ollama's default context (~2-4k) truncates the CLI's huge system prompt/tools,
  // making the model echo a tool template instead of working. num_ctx must always
  // be present, even with no other options.
  assert.ok(anthropicToOllama({ messages: [] }).options.num_ctx >= 32768);
  assert.ok(anthropicToOllama({ messages: [], temperature: 0.5 }).options.num_ctx >= 32768);
});

test('ollamaChunkToAnthropicEvents: a streamed text turn produces the exact event order', () => {
  const state = { messageId: 'msg_1', model: 'llama3.1:8b' };
  const first = ollamaChunkToAnthropicEvents({ message: { role: 'assistant', content: 'Hel' }, done: false }, state);
  assert.deepEqual(first.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta']);
  assert.equal(first[0].message.id, 'msg_1');
  assert.deepEqual(first[2].delta, { type: 'text_delta', text: 'Hel' });

  const second = ollamaChunkToAnthropicEvents({ message: { content: 'lo' }, done: false }, state);
  assert.deepEqual(second.map((e) => e.type), ['content_block_delta']);

  const last = ollamaChunkToAnthropicEvents({ message: { content: '' }, done: true, done_reason: 'stop', eval_count: 5 }, state);
  assert.deepEqual(last.map((e) => e.type), ['content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(last[1].delta.stop_reason, 'end_turn');
  assert.equal(last[1].usage.output_tokens, 5);
});

test('ollamaChunkToAnthropicEvents: a tool call emits input_json_delta and a tool_use stop reason', () => {
  const state = { messageId: 'msg_2', model: 'x' };
  ollamaChunkToAnthropicEvents({ message: { content: '' }, done: false }, state); // message_start only
  const tc = ollamaChunkToAnthropicEvents({ message: { tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }] }, done: false }, state);
  assert.deepEqual(tc.map((e) => e.type), ['content_block_start', 'content_block_delta', 'content_block_stop']);
  assert.equal(tc[0].content_block.type, 'tool_use');
  assert.equal(tc[0].content_block.name, 'read');
  assert.deepEqual(tc[1].delta, { type: 'input_json_delta', partial_json: '{"path":"a"}' });

  const done = ollamaChunkToAnthropicEvents({ message: { content: '' }, done: true }, state);
  assert.equal(done.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('ollamaDoneToStopReason: maps stop/length/tool_use', () => {
  assert.equal(ollamaDoneToStopReason({ done_reason: 'stop' }), 'end_turn');
  assert.equal(ollamaDoneToStopReason({ done_reason: 'length' }), 'max_tokens');
  assert.equal(ollamaDoneToStopReason({ done_reason: 'stop' }, true), 'tool_use');
  assert.equal(ollamaDoneToStopReason({ message: { tool_calls: [{}] } }), 'tool_use');
});

test('nonStreamToAnthropic: assembles a full message with text + tool_use', () => {
  const msg = nonStreamToAnthropic(
    { model: 'x', message: { content: 'hi', tool_calls: [{ function: { name: 'read', arguments: { p: 1 } } }] }, prompt_eval_count: 3, eval_count: 7 },
    { id: 'msg_9', model: 'ollama-x' },
  );
  assert.equal(msg.id, 'msg_9');
  assert.equal(msg.role, 'assistant');
  assert.deepEqual(msg.content[0], { type: 'text', text: 'hi' });
  assert.equal(msg.content[1].type, 'tool_use');
  assert.equal(msg.content[1].name, 'read');
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.usage, { input_tokens: 3, output_tokens: 7 });
});
