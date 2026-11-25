const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/main/chatgpt-translate-lib');
const providers = require('../src/main/provider-accounts-lib');
const { modelFamily, canSwitchModel } = require('../src/main/agent-providers');

test('chatgpt model ids are a frozen family and spawn through the /g route', () => {
  assert.equal(modelFamily('chatgpt:sol'), 'chatgpt');
  assert.equal(canSwitchModel('chatgpt:sol', 'chatgpt:luna'), false);
  const env = providers.chatgptSpawnEnv({ port: 5, model: 'chatgpt:astra', subagentModel: 'default' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5/g');
  assert.equal(env.ANTHROPIC_MODEL, 'astra');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'luna');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'astra');
  assert.deepEqual(providers.splitProviderPath('/g/v1/messages'), { provider: 'chatgpt', path: '/v1/messages' });
});

test('chatgptFamilyOf finds the family in an alias and defaults to sol', () => {
  assert.equal(lib.chatgptFamilyOf('luna'), 'luna');
  assert.equal(lib.chatgptFamilyOf('claude-opus-4'), 'sol');
  assert.equal(lib.chatgptFamilyOf('gpt-6-terra'), 'terra');
});

test('anthropicToResponses maps system, text, tool use, results and tools', () => {
  const body = lib.anthropicToResponses({
    system: [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Be kind.' }],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }, { type: 'text', text: 'thanks' }] },
    ],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
  }, 'gpt-6-sol');
  assert.equal(body.model, 'gpt-6-sol');
  assert.equal(body.instructions, 'Be brief.\nBe kind.');
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
    { type: 'function_call', call_id: 't1', name: 'Bash', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 't1', output: 'a.txt' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ]);
  assert.equal(body.tools[0].name, 'Bash');
  assert.equal(body.tool_choice, 'required');
});

test('anthropicToResponses falls back to non-empty instructions and maps images', () => {
  const body = lib.anthropicToResponses({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }] }, 'm');
  assert.ok(body.instructions.length > 0);
  assert.deepEqual(body.input[0].content[0], { type: 'input_image', image_url: 'data:image/png;base64,AA' });
  assert.equal(body.tools, undefined);
});

function run(events, model = 'luna') {
  const state = lib.newStreamState({ messageId: 'msg_1', model });
  return { out: events.flatMap((e) => lib.responsesEventToAnthropic(e, state)), state };
}

test('a text answer streams as one text block and ends with usage', () => {
  const { out } = run([
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'message' } },
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.output_item.done', item: { type: 'message' } },
    { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } },
  ]);
  assert.deepEqual(out.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const end = out.find((e) => e.type === 'message_delta');
  assert.equal(end.delta.stop_reason, 'end_turn');
  assert.deepEqual(end.usage, { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 7 });
});

test('a function call streams as a tool_use block and sets stop_reason tool_use', () => {
  const { out } = run([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_9', name: 'Bash' } },
    { type: 'response.function_call_arguments.delta', delta: '{"cmd":' },
    { type: 'response.function_call_arguments.delta', delta: '"ls"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: {} },
  ]);
  const start = out.find((e) => e.type === 'content_block_start');
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 'call_9', name: 'Bash', input: {} });
  assert.equal(out.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.partial_json).join(''), '{"cmd":"ls"}');
  assert.equal(out.find((e) => e.type === 'message_delta').delta.stop_reason, 'tool_use');
});

test('arguments that only arrive on the finished item are still delivered', () => {
  const { out } = run([
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c', name: 'T' } },
    { type: 'response.output_item.done', item: { type: 'function_call', arguments: '{"a":1}' } },
    { type: 'response.completed', response: {} },
  ]);
  assert.equal(out.find((e) => e.type === 'content_block_delta').delta.partial_json, '{"a":1}');
});

test('incomplete on max_output_tokens maps to max_tokens, failures to an error event', () => {
  assert.equal(run([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]).out.find((e) => e.type === 'message_delta').delta.stop_reason, 'max_tokens');
  const failed = run([{ type: 'response.failed', response: { error: { message: 'boom' } } }]).out;
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).error.message, 'boom');
});

test('foldEventsToMessage builds the non-streaming message', () => {
  const { out } = run([
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: 'response.output_item.done', item: { type: 'message' } },
    { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c', name: 'T' } },
    { type: 'response.function_call_arguments.delta', delta: '{"a":1}' },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 2 } } },
  ]);
  const message = lib.foldEventsToMessage(out, lib.newStreamState({ messageId: 'msg_1', model: 'luna' }));
  assert.equal(message.content[0].text, 'ok');
  assert.deepEqual(message.content[1].input, { a: 1 });
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.usage.output_tokens, 2);
});

test('createSseParser handles events split across chunks and skips junk', () => {
  const seen = [];
  const parser = lib.createSseParser((e) => seen.push(e));
  parser.feed('event: a\ndata: {"type":"x"');
  parser.feed('}\n\ndata: nope\n\ndata: [DONE]\n\ndata: {"type":"y"}\r\n\r\n');
  assert.deepEqual(seen, [{ type: 'x' }, { type: 'y' }]);
});

test('anthropicErrorFor names the error type the CLI reacts to', () => {
  const limit = lib.anthropicErrorFor(429, JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }));
  assert.equal(limit.error.type, 'rate_limit_error');
  assert.equal(limit.error.message, 'The usage limit has been reached');
  assert.equal(lib.anthropicErrorFor(400, '{"detail":"Store must be set to false"}').error.message, 'Store must be set to false');
  assert.equal(lib.anthropicErrorFor(401, 'x').error.type, 'authentication_error');
});

test('estimateInputTokens grows with the request size', () => {
  assert.ok(lib.estimateInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }) >= 1000);
});

test('reasoning effort follows the CLI effort, then the thinking budget, else medium', () => {
  const effortOf = (request) => lib.anthropicToResponses({ messages: [], ...request }, 'm').reasoning.effort;
  assert.equal(effortOf({ output_config: { effort: 'high' } }), 'high');
  assert.equal(effortOf({ output_config: { effort: 'max' } }), 'xhigh');
  assert.equal(effortOf({ thinking: { type: 'enabled', budget_tokens: 32000 } }), 'high');
  assert.equal(effortOf({}), 'medium');
});
