'use strict';

// Pure, Electron-free translation between the Anthropic Messages API (what the
// `claude` CLI speaks) and the Responses API of ChatGPT's Codex backend
// (`chatgpt.com/backend-api/codex/responses`, reached with a ChatGPT login). It lets
// Claude Code run on a ChatGPT subscription: the account proxy (account-proxy.js)
// serves `/g/v1/messages`, translates the request here, forwards it with the
// active Codex account's login and translates the event stream back.
// Unit-tested in test/chatgpt-translate-lib.test.js.

const FALLBACK_INSTRUCTIONS = 'You are a helpful coding assistant.';
const CODEX_RESPONSES_PATH = '/backend-api/codex/responses';

// --- request:  Anthropic /v1/messages  ->  Responses ---------------------------

function systemToString(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// A tool_result's content is a string or blocks; the Responses API takes a string.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (b && b.type === 'text') return b.text || '';
    if (b && b.type === 'image') return '[image omitted]';
    return '';
  }).filter(Boolean).join('\n');
}

function imageUrlOf(block) {
  const source = block.source || {};
  if (source.type === 'base64' && source.data) return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  if (source.type === 'url' && source.url) return source.url;
  return '';
}

// One Anthropic message → Responses input items. Order is kept: a user turn that
// answers tool calls and then adds text stays "outputs, then text".
function messageToInputItems(message) {
  const items = [];
  const isAssistant = message.role === 'assistant';
  const textType = isAssistant ? 'output_text' : 'input_text';
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  let parts = [];
  const flushParts = () => {
    if (parts.length) items.push({ type: 'message', role: isAssistant ? 'assistant' : 'user', content: parts });
    parts = [];
  };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue;
    if (block.type === 'text' && block.text) parts.push({ type: textType, text: block.text });
    else if (block.type === 'image' && !isAssistant) {
      const url = imageUrlOf(block);
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (block.type === 'tool_use') {
      flushParts();
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) });
    } else if (block.type === 'tool_result') {
      flushParts();
      items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolResultText(block.content) });
    }
    // thinking / redacted_thinking blocks carry Anthropic signatures: not replayable here.
  }
  flushParts();
  return items;
}

function toolsToResponses(tools) {
  return (Array.isArray(tools) ? tools : []).filter((t) => t && t.name).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.input_schema || { type: 'object', properties: {} },
    strict: false,
  }));
}

function toolChoiceToResponses(choice) {
  if (!choice) return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { type: 'function', name: choice.name };
  return 'auto';
}

// Claude Code's thinking budget → a reasoning effort. No thinking asked = medium.
function reasoningEffortOf(request) {
  const thinking = request.thinking;
  if (thinking && thinking.type === 'enabled') {
    const budget = Number(thinking.budget_tokens) || 0;
    if (budget >= 24000) return 'high';
    if (budget > 0 && budget < 2000) return 'low';
    return 'medium';
  }
  return 'medium';
}

// `modelName` is the Responses-side model (already resolved from the alias).
function anthropicToResponses(request = {}, modelName) {
  const input = [];
  for (const message of request.messages || []) if (message) input.push(...messageToInputItems(message));
  const body = {
    model: modelName,
    instructions: systemToString(request.system) || FALLBACK_INSTRUCTIONS,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: reasoningEffortOf(request), summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };
  const tools = toolsToResponses(request.tools);
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoiceToResponses(request.tool_choice);
  }
  return body;
}

// The model family an alias names: `sol`, `astra`, `terra` or `luna` anywhere in it.
function chatgptFamilyOf(name) {
  const match = /(sol|astra|terra|luna)/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : 'sol';
}

// --- stream:  Responses SSE events  ->  Anthropic SSE events -------------------

// Splits an SSE byte stream into JSON event payloads (`data:` lines). Feed it
// string chunks; it calls `onEvent(object)` for every complete event.
function createSseParser(onEvent) {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += chunk;
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer[end] === '\r' ? 4 : 2));
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { onEvent(JSON.parse(data)); } catch { /* a malformed event is skipped */ }
      }
    },
  };
}

function newStreamState({ messageId, model }) {
  return { messageId, model, started: false, blockIndex: -1, openBlock: null, sawToolUse: false, finished: false };
}

function closeOpenBlock(state, events) {
  if (state.openBlock) {
    events.push({ type: 'content_block_stop', index: state.blockIndex });
    state.openBlock = null;
  }
}

function openBlock(state, events, kind, contentBlock) {
  closeOpenBlock(state, events);
  state.blockIndex += 1;
  state.openBlock = kind;
  events.push({ type: 'content_block_start', index: state.blockIndex, content_block: contentBlock });
}

function messageStartEvent(state) {
  return {
    type: 'message_start',
    message: {
      id: state.messageId, type: 'message', role: 'assistant', model: state.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

function usageOf(response) {
  const usage = (response && response.usage) || {};
  const cached = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (usage.input_tokens || 0) - cached),
    cache_read_input_tokens: cached,
    output_tokens: usage.output_tokens || 0,
  };
}

function stopReasonOf(response, sawToolUse) {
  if (sawToolUse) return 'tool_use';
  const reason = response && response.incomplete_details && response.incomplete_details.reason;
  return reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn';
}

function finishEvents(state, response) {
  const events = [];
  closeOpenBlock(state, events);
  state.finished = true;
  events.push({ type: 'message_delta', delta: { stop_reason: stopReasonOf(response, state.sawToolUse), stop_sequence: null }, usage: usageOf(response) });
  events.push({ type: 'message_stop' });
  return events;
}

// One Responses event → the Anthropic events it produces (possibly none). `state`
// is seeded by newStreamState and carries the open block across events.
function responsesEventToAnthropic(event, state) {
  const events = [];
  if (!event || state.finished) return events;
  if (!state.started) {
    state.started = true;
    events.push(messageStartEvent(state));
  }
  switch (event.type) {
    case 'response.output_item.added': {
      const item = event.item || {};
      if (item.type === 'function_call') {
        state.sawToolUse = true;
        state.argumentsStreamed = false;
        openBlock(state, events, 'tool_use', { type: 'tool_use', id: item.call_id || item.id, name: item.name || '', input: {} });
      }
      break;
    }
    case 'response.output_text.delta': {
      if (state.openBlock !== 'text') openBlock(state, events, 'text', { type: 'text', text: '' });
      events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: event.delta || '' } });
      break;
    }
    case 'response.function_call_arguments.delta': {
      if (state.openBlock === 'tool_use' && event.delta) {
        state.argumentsStreamed = true;
        events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: event.delta } });
      }
      break;
    }
    case 'response.output_item.done': {
      const item = event.item || {};
      if (item.type === 'function_call' && state.openBlock === 'tool_use') {
        // Arguments that never streamed arrive whole on the finished item.
        if (!state.argumentsStreamed && item.arguments) {
          events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: item.arguments } });
        }
        closeOpenBlock(state, events);
      } else if (item.type === 'message') closeOpenBlock(state, events);
      break;
    }
    case 'response.completed':
    case 'response.incomplete':
      events.push(...finishEvents(state, event.response));
      break;
    case 'response.failed':
    case 'error': {
      const error = (event.response && event.response.error) || event.error || event;
      state.finished = true;
      closeOpenBlock(state, events);
      events.push({ type: 'error', error: { type: 'api_error', message: String(error.message || error.code || 'ChatGPT request failed') } });
      break;
    }
    default:
      break; // reasoning, content_part and bookkeeping events have no Anthropic counterpart
  }
  return events;
}

// Folds the Anthropic events of one response into the single message a
// non-streaming request expects.
function foldEventsToMessage(events, state) {
  const message = messageStartEvent(state).message;
  const toolInputs = new Map();
  for (const event of events) {
    if (event.type === 'content_block_start') {
      message.content[event.index] = { ...event.content_block };
      if (event.content_block.type === 'tool_use') toolInputs.set(event.index, '');
    } else if (event.type === 'content_block_delta') {
      const block = message.content[event.index];
      if (event.delta.type === 'text_delta') block.text += event.delta.text;
      else if (event.delta.type === 'input_json_delta') toolInputs.set(event.index, toolInputs.get(event.index) + event.delta.partial_json);
    } else if (event.type === 'message_delta') {
      message.stop_reason = event.delta.stop_reason;
      message.usage = event.usage;
    }
  }
  for (const [index, json] of toolInputs) {
    try { message.content[index].input = json ? JSON.parse(json) : {}; } catch { message.content[index].input = {}; }
  }
  return message;
}

// A rough token count for `count_tokens` (ChatGPT has no such endpoint): ~4 chars per token.
function estimateInputTokens(request = {}) {
  const text = JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools });
  return Math.ceil(text.length / 4);
}

// An upstream failure body → the Anthropic error type the CLI reacts to.
function anthropicErrorFor(status, upstreamBody) {
  let message = '';
  try {
    const parsed = JSON.parse(upstreamBody);
    message = (parsed.error && (parsed.error.message || parsed.error.code)) || parsed.detail || '';
  } catch { message = String(upstreamBody || '').slice(0, 300); }
  const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : 'api_error';
  return { type: 'error', error: { type, message: message || `ChatGPT answered ${status}` } };
}

module.exports = {
  CODEX_RESPONSES_PATH, anthropicToResponses, chatgptFamilyOf, createSseParser, newStreamState,
  responsesEventToAnthropic, foldEventsToMessage, estimateInputTokens, anthropicErrorFor,
};
