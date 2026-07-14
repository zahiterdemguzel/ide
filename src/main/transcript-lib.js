// Pure (Electron-free) reader for Claude Code's own session transcript — the JSONL
// file it appends every user turn, assistant message and tool call to, whose path
// rides on every hook payload (`transcript_path`).
//
// It exists so a client can render a session as a *conversation* instead of a
// terminal: the phone shows an AI-chat UI, and scraping the TUI's redrawn ANSI box
// for that would be guesswork. The transcript is the same data the TUI itself
// draws, in structured form.
//
// The file is append-only, so this is written as an incremental reducer: `feed()`
// takes whatever bytes arrived since the last read, keeps the trailing partial line
// for next time, and returns just the messages that changed. A tool's result lands
// in a *later* line than its call, so a result patches the message that already
// carries the call — which is why callers upsert by uuid rather than append.
//
// Unit-tested in test/transcript-lib.test.js.

// Rendered conversation kept in memory per session. Enough to scroll back through a
// long session on a phone; the whole file (which can be tens of MB) never is.
const MAX_MESSAGES = 400;
// One tool result can be an entire file's contents. The phone shows a preview and
// nothing more, so never put more than this on the wire.
const MAX_OUTPUT = 2000;
const MAX_TEXT = 20_000;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n…' : s);

// A slash command typed into the TUI is recorded as markup, not as the text the
// user sees ("<command-name>/init</command-name><command-args>…"). Turn it back
// into the line they typed. Anything the CLI injects around a turn — the
// system-reminder blocks, a local command's stdout — is machinery, not conversation.
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const STRIP_TAGS = /<(system-reminder|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;

function userText(raw) {
  const cmd = COMMAND_NAME.exec(raw);
  if (cmd) {
    const args = (COMMAND_ARGS.exec(raw)?.[1] || '').trim();
    return (cmd[1].trim() + (args ? ' ' + args : '')).trim();
  }
  return raw.replace(STRIP_TAGS, '').trim();
}

// The one-line summary a tool call gets in the chat, alongside its name — the same
// thing the TUI puts after the tool's name ("Read(src/main/sessions.js)"). `cwd` is
// the session's project folder, so a path inside it reads as a project-relative one.
function toolTitle(name, input, cwd) {
  const i = input && typeof input === 'object' ? input : {};
  const rel = (p) => {
    const s = String(p || '');
    if (!cwd || !s.startsWith(cwd)) return s;
    return s.slice(cwd.length).replace(/^[\\/]+/, '');
  };
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return rel(i.file_path);
    case 'NotebookEdit':
      return rel(i.notebook_path);
    case 'Bash': case 'BashOutput':
      return String(i.command || i.description || '').split('\n')[0];
    case 'Glob':
      return String(i.pattern || '');
    case 'Grep':
      return String(i.pattern || '');
    case 'Task': case 'Agent':
      return String(i.description || i.subagent_type || '');
    case 'WebFetch':
      return String(i.url || '');
    case 'WebSearch':
      return String(i.query || '');
    case 'TodoWrite':
      return `${(Array.isArray(i.todos) ? i.todos : []).length} items`;
    default:
      return String(i.description || i.file_path || i.path || i.query || '');
  }
}

// A tool_result's content is a string on some CLI versions and a content-block array
// on others; an error result is flagged rather than typed.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => String(b.text || ''))
    .join('\n');
}

// One entry's content blocks → the chat blocks we render. An image is reduced to a
// marker: the transcript carries it base64-inlined, and shipping that to a phone that
// just sent it would be absurd.
function contentBlocks(content, cwd) {
  if (typeof content === 'string') {
    const text = userText(content);
    return text ? [{ t: 'text', text: clip(text, MAX_TEXT) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      const text = userText(String(b.text || ''));
      if (text) out.push({ t: 'text', text: clip(text, MAX_TEXT) });
    } else if (b.type === 'thinking') {
      const text = String(b.thinking || b.text || '').trim();
      if (text) out.push({ t: 'thinking', text: clip(text, MAX_TEXT) });
    } else if (b.type === 'tool_use') {
      out.push({
        t: 'tool',
        id: String(b.id || ''),
        name: String(b.name || 'tool'),
        title: clip(toolTitle(String(b.name || ''), b.input, cwd), 200),
        status: 'running',
        output: '',
      });
    } else if (b.type === 'image') {
      out.push({ t: 'image' });
    }
  }
  return out;
}

const createState = () => ({ msgs: [], tools: new Map(), partial: '' });

// Drop the oldest messages once the window is full, un-indexing their tool calls so
// a late result can't patch a message no client is holding any more.
function trim(state) {
  while (state.msgs.length > MAX_MESSAGES) {
    const gone = state.msgs.shift();
    for (const b of gone.blocks) if (b.t === 'tool') state.tools.delete(b.id);
  }
}

// Fold one transcript entry into the state. Returns the message it created or
// changed, or null for an entry that isn't part of the conversation.
function applyEntry(state, e) {
  if (!e || typeof e !== 'object') return null;
  // A subagent's own conversation (isSidechain) is a separate thread the TUI doesn't
  // show inline either; the Task tool call that spawned it is already in the chat.
  if (e.isSidechain || e.isMeta) return null;
  if (e.type !== 'user' && e.type !== 'assistant') return null;
  const msg = e.message;
  if (!msg || typeof msg !== 'object') return null;

  // A tool_result is not a turn: it completes the tool call already on screen.
  if (e.type === 'user' && Array.isArray(msg.content)) {
    const results = msg.content.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      let touched = null;
      for (const r of results) {
        const target = state.tools.get(String(r.tool_use_id || ''));
        if (!target) continue;
        target.block.status = r.is_error ? 'error' : 'ok';
        target.block.output = clip(resultText(r.content).trim(), MAX_OUTPUT);
        touched = target.msg;
      }
      return touched;
    }
  }

  const blocks = contentBlocks(msg.content, e.cwd);
  if (!blocks.length) return null;
  const out = {
    uuid: String(e.uuid || `${state.msgs.length}`),
    role: e.type,
    ts: e.timestamp || '',
    blocks,
  };
  state.msgs.push(out);
  for (const b of blocks) if (b.t === 'tool' && b.id) state.tools.set(b.id, { msg: out, block: b });
  trim(state);
  return out;
}

// Feed the bytes appended since the last call. Returns the messages that were added
// or patched, in order, deduped — a caller upserts them by uuid.
function feed(state, chunk) {
  state.partial += chunk;
  const lines = state.partial.split('\n');
  state.partial = lines.pop() ?? '';
  const changed = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a torn write; the next read has it whole
    const msg = applyEntry(state, entry);
    if (msg) changed.set(msg.uuid, msg);
  }
  return [...changed.values()];
}

// Whole-file convenience for a session that isn't running (an archived one still has
// its transcript on disk).
function parseTranscript(text) {
  const state = createState();
  feed(state, text.endsWith('\n') ? text : text + '\n');
  return state.msgs;
}

module.exports = { createState, feed, applyEntry, parseTranscript, toolTitle, userText, MAX_MESSAGES };
