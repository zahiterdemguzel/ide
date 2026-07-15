// Pure, Electron-free translation between the Anthropic Messages API (what the
// `claude` CLI speaks) and Ollama's /api/chat. The CLI only knows how to talk to
// an Anthropic endpoint, so to run a local Ollama model we point it at a local
// proxy (src/main/ollama-proxy.js) that speaks /v1/messages and forwards here.
// All the shape-mapping lives in this file so it stays unit-tested
// (test/ollama-translate-lib.test.js); the proxy is just socket plumbing.

// The context window Claude Code needs to function: its system prompt + tool
// schemas run well past Ollama's default (~2–4k), so the model must be given room
// for the whole prompt or it can't see the task. 32k fits the CLI's prompt with
// headroom for a real conversation; Ollama clamps it to the model's trained max.
const CLAUDE_CODE_MIN_CTX = 32768;

// --- request:  Anthropic /v1/messages  ->  Ollama /api/chat ------------------

function systemToString(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  // The CLI sends `system` as an array of text blocks; flatten to one string.
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function textFromBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function anthropicMessagesToOllama(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    // Ollama has no per-block tool results: a tool_result becomes its own
    // {role:'tool'} message, while text + tool_use fold into the turn's message.
    let text = '';
    const toolCalls = [];
    const toolResults = [];
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ function: { name: b.name, arguments: b.input || {} } });
      else if (b.type === 'tool_result') toolResults.push({ role: 'tool', content: textFromBlocks(b.content) });
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else if (text || !toolResults.length) {
      out.push({ role: m.role, content: text });
    }
    for (const tr of toolResults) out.push(tr);
  }
  return out;
}

function anthropicToOllama(req = {}) {
  const messages = [];
  const sys = systemToString(req.system);
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push(...anthropicMessagesToOllama(req.messages));

  const body = { model: req.model, messages, stream: req.stream !== false };

  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // Ollama defaults to a tiny context window (~2–4k tokens). Claude Code's system
  // prompt + tool schemas dwarf that, so at the default the prompt is silently
  // truncated and the model only sees the tail of the tool-format instructions —
  // which it echoes back as a `{"name": <function-name>, "arguments": …}` template
  // instead of doing the task. Always request a context large enough to hold the
  // CLI's prompt so tool use actually works. (Ollama caps this at the model's own
  // trained maximum, so an over-large value is safe.)
  const options = { num_ctx: CLAUDE_CODE_MIN_CTX };
  if (typeof req.temperature === 'number') options.temperature = req.temperature;
  if (typeof req.top_p === 'number') options.top_p = req.top_p;
  if (typeof req.max_tokens === 'number') options.num_predict = req.max_tokens;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) options.stop = req.stop_sequences;
  body.options = options;

  return body;
}

// --- stop reason -------------------------------------------------------------

function ollamaDoneToStopReason(chunk, sawToolUse) {
  if (sawToolUse) return 'tool_use';
  const msg = chunk && chunk.message;
  if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) return 'tool_use';
  if (chunk && chunk.done_reason === 'length') return 'max_tokens';
  return 'end_turn';
}

// --- streaming:  Ollama NDJSON chunk  ->  Anthropic SSE events ----------------
// `state` carries the open-block bookkeeping across the whole response. Seed it
// as { messageId, model } (started/blockIndex/etc. are filled here).

function ollamaChunkToAnthropicEvents(chunk, state) {
  const events = [];
  if (!state.started) {
    state.started = true;
    state.blockIndex = -1;
    state.blockType = null;
    state.sawToolUse = false;
    events.push({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  const msg = (chunk && chunk.message) || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  if (text) {
    if (state.blockType !== 'text') {
      if (state.blockIndex >= 0 && state.blockType) events.push({ type: 'content_block_stop', index: state.blockIndex });
      state.blockIndex += 1;
      state.blockType = 'text';
      events.push({ type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } });
    }
    events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text } });
  }

  for (const tc of toolCalls) {
    if (state.blockIndex >= 0 && state.blockType) events.push({ type: 'content_block_stop', index: state.blockIndex });
    state.blockIndex += 1;
    state.blockType = null; // tool blocks open and close within this iteration
    state.sawToolUse = true;
    const fn = tc.function || {};
    const id = `toolu_${state.messageId}_${state.blockIndex}`;
    // Ollama delivers a tool call's arguments whole (not streamed), so emit the
    // full JSON as a single input_json_delta.
    const args = fn.arguments == null ? {} : fn.arguments;
    const partial = typeof args === 'string' ? args : JSON.stringify(args);
    events.push({ type: 'content_block_start', index: state.blockIndex, content_block: { type: 'tool_use', id, name: fn.name || '', input: {} } });
    events.push({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: partial } });
    events.push({ type: 'content_block_stop', index: state.blockIndex });
  }

  if (chunk && chunk.done) {
    if (state.blockType === 'text' && state.blockIndex >= 0) {
      events.push({ type: 'content_block_stop', index: state.blockIndex });
      state.blockType = null;
    }
    events.push({
      type: 'message_delta',
      delta: { stop_reason: ollamaDoneToStopReason(chunk, state.sawToolUse), stop_sequence: null },
      usage: {
        input_tokens: typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : 0,
        output_tokens: typeof chunk.eval_count === 'number' ? chunk.eval_count : 0,
      },
    });
    events.push({ type: 'message_stop' });
  }
  return events;
}

// --- non-streaming:  full Ollama /api/chat response  ->  Anthropic message ----

function nonStreamToAnthropic(resp, opts = {}) {
  const msg = (resp && resp.message) || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  toolCalls.forEach((tc, i) => {
    const fn = tc.function || {};
    content.push({ type: 'tool_use', id: `toolu_${opts.id || 'msg'}_${i}`, name: fn.name || '', input: fn.arguments || {} });
  });
  return {
    id: opts.id || 'msg_local',
    type: 'message',
    role: 'assistant',
    model: opts.model || (resp && resp.model) || '',
    content,
    stop_reason: ollamaDoneToStopReason(resp, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: (resp && resp.prompt_eval_count) || 0,
      output_tokens: (resp && resp.eval_count) || 0,
    },
  };
}

module.exports = {
  anthropicToOllama,
  ollamaChunkToAnthropicEvents,
  ollamaDoneToStopReason,
  nonStreamToAnthropic,
};
