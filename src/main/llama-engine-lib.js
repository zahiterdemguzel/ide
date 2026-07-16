// Pure, Electron-free request/response shaping for the node-llama-cpp engine
// (src/main/llama-engine.js). These translate between the Ollama /api/chat shape
// the proxy speaks (produced by ollama-translate-lib.js) and node-llama-cpp's
// LlamaChat API. Kept here so the fiddly bits — especially folding tool results
// back into assistant turns — stay unit-tested (test/llama-engine-lib.test.js);
// the engine shell just wires these to the native library.

// Ollama-shaped messages -> node-llama-cpp ChatHistoryItem[]. The translate lib
// hands us system/user/assistant/tool messages: a tool_use folds into the
// assistant turn as `tool_calls`, and each tool_result is its own {role:'tool'}
// message that immediately follows. We fold those back so each assistant turn is
// one {type:'model'} item whose response array holds its text plus functionCall
// items paired with their results.
function buildHistory(messages) {
  const history = [];
  const list = Array.isArray(messages) ? messages : [];
  let i = 0;
  while (i < list.length) {
    const m = list[i] || {};
    if (m.role === 'system') { history.push({ type: 'system', text: String(m.content || '') }); i += 1; continue; }
    if (m.role === 'user') { history.push({ type: 'user', text: String(m.content || '') }); i += 1; continue; }
    if (m.role === 'assistant') {
      const response = [];
      if (m.content) response.push(String(m.content));
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      i += 1;
      for (const call of calls) {
        const fn = (call && call.function) || {};
        let result = '';
        if (list[i] && list[i].role === 'tool') { result = String(list[i].content || ''); i += 1; }
        response.push({ type: 'functionCall', name: fn.name || '', params: fn.arguments == null ? {} : fn.arguments, result });
      }
      history.push({ type: 'model', response });
      continue;
    }
    // An orphan tool result with no preceding assistant call — surface as text so
    // it isn't silently dropped.
    if (m.role === 'tool') { history.push({ type: 'user', text: String(m.content || '') }); i += 1; continue; }
    i += 1;
  }
  // generateResponse writes into a trailing model slot; add an empty one unless the
  // history already ends on a model turn (a continuation after tool results).
  if (!history.length || history[history.length - 1].type !== 'model') {
    history.push({ type: 'model', response: [] });
  }
  return history;
}

// Ollama tool defs (`[{ function: { name, description, parameters } }]`) ->
// node-llama-cpp function map (`{ name: { description, params } }`). No handler:
// LlamaChat returns the calls for the CLI to execute, it doesn't run them.
// Returns undefined when there are no usable tools (LlamaChat wants the option
// omitted, not an empty object).
function buildFunctions(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = {};
  for (const t of list) {
    const fn = (t && t.function) || {};
    if (!fn.name) continue;
    out[fn.name] = { description: fn.description || '', params: fn.parameters || { type: 'object', properties: {} } };
  }
  return Object.keys(out).length ? out : undefined;
}

// Ollama options (`{ temperature, top_p, num_predict, stop }`) -> LlamaChat
// generateResponse options.
function buildGenOptions(options) {
  const o = options || {};
  const opts = {};
  if (typeof o.temperature === 'number') opts.temperature = o.temperature;
  if (typeof o.top_p === 'number') opts.topP = o.top_p;
  if (typeof o.num_predict === 'number' && o.num_predict > 0) opts.maxTokens = o.num_predict;
  if (Array.isArray(o.stop) && o.stop.length) opts.customStopTriggers = o.stop.slice();
  return opts;
}

// node-llama-cpp functionCalls (`[{ functionName, params }]`) -> Ollama-shaped
// tool_calls (`[{ function: { name, arguments } }]`).
function toToolCalls(functionCalls) {
  const list = Array.isArray(functionCalls) ? functionCalls : [];
  return list.map((c) => ({ function: { name: c.functionName, arguments: c.params == null ? {} : c.params } }));
}

// Map LlamaChat's stopReason to Ollama's done_reason (only 'length' is special-
// cased downstream; everything else is a normal stop).
function doneReason(stopReason) {
  return stopReason === 'maxTokens' ? 'length' : 'stop';
}

// A response that *starts* like a tool call the model printed as text instead of
// emitting the native tool-call tokens (weak/small models do this). Used to decide
// whether to withhold streaming a turn's text until we can tell if it salvages to a
// real tool call (see salvageToolCall).
function looksLikeToolCallStart(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  return t.startsWith('```') || t.startsWith('{') || t.startsWith('<tool_call>');
}

// A parsed `{ name, arguments }` object -> an Ollama tool_call, but only when it
// actually names a KNOWN tool (so a random JSON object in a normal answer is never
// mistaken for a call). `arguments` may be an object or absent (a no-arg tool).
function asToolCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = typeof obj.name === 'string' ? obj.name : null;
  if (!name || !toolNames.includes(name)) return null;
  const args = obj.arguments === undefined ? {} : obj.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  return { function: { name, arguments: args } };
}

// Every top-level balanced `{...}` substring, honoring string literals so a brace
// inside a JSON string doesn't throw off the nesting. Used to find a tool-call
// object even when the model buried it in prose.
function jsonObjectCandidates(text) {
  const s = String(text);
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '{') continue;
    let depth = 0; let inStr = false; let esc = false;
    for (let j = i; j < s.length; j += 1) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) { out.push(s.slice(i, j + 1)); i = j; break; } }
    }
  }
  return out;
}

// Salvage a tool call from model TEXT when the native parser found none but tools
// were offered — so small models that print `{"name":…,"arguments":…}` instead of
// calling natively are still usable as agents. It scans, in order of confidence, the
// whole trimmed reply, any ```json fence / <tool_call> wrapper, and finally any bare
// balanced `{...}` object embedded in prose ("Here's how you can use the Glob tool:
// {…}"), returning the first object that names a KNOWN tool. Requiring a known tool
// name keeps a normal answer that merely contains JSON from being read as a call.
// Returns Ollama-shaped tool_calls (`[{ function: { name, arguments } }]`) or null.
function salvageToolCall(text, toolNames) {
  if (!text || !Array.isArray(toolNames) || !toolNames.length) return null;
  const raw = String(text);
  const candidates = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);
  const push = (re) => { let m; while ((m = re.exec(raw)) !== null) candidates.push(m[1].trim()); };
  push(/```(?:json)?\s*([\s\S]*?)```/gi);
  push(/<tool_call>\s*([\s\S]*?)<\/tool_call>/gi);
  for (const obj of jsonObjectCandidates(raw)) candidates.push(obj);

  for (const c of candidates) {
    if (!c || c[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(c); } catch { continue; }
    const call = asToolCall(obj, toolNames);
    if (call) return [call];
  }
  return null;
}

module.exports = {
  buildHistory, buildFunctions, buildGenOptions, toToolCalls, doneReason,
  looksLikeToolCallStart, salvageToolCall,
};
