// The chat view of a Claude session — what the phone renders instead of a terminal.
//
// Three things a conversation needs that a PTY stream doesn't give you:
//
//  - the messages. Claude Code appends every turn, tool call and result to its own
//    JSONL transcript; its path arrives on every hook payload, so sessions.js hands
//    it here and we tail the file. transcript-lib.js turns the bytes into messages.
//  - the question it is blocked on. A permission prompt is drawn *in the TUI* and
//    exists nowhere else (Claude records the tool call only once it's allowed), so a
//    chat that ignored it would sit there looking idle. While the session is
//    `needs-input` we lift the box out of the PTY tail (tui-prompt.js) and push it.
//  - the slash commands and image attachments the composer needs.
//
// Everything stateful here is keyed by session id and torn down with the session.
// The pure halves live in transcript-lib.js / tui-prompt.js / slash-commands-lib.js.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { handle: bridgeHandle } = require('./remote-bridge');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { createState, feed, parseTranscript, MAX_MESSAGES } = require('./transcript-lib');
const { parseAsk } = require('./tui-prompt');
const { BUILTIN, commandName, commandDescription, mergeCommands } = require('./slash-commands-lib');

// Claude writes a turn as one appended line, so a short debounce coalesces the burst
// of writes a single message makes without making the chat feel laggy.
const READ_DEBOUNCE_MS = 80;
// The TUI repaints its box a few times as it appears; parse once it settles.
const ASK_DEBOUNCE_MS = 250;
// Only the last stretch of the PTY tail can hold the box that's currently on screen.
const ASK_TAIL_CHARS = 8000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const paths = new Map();   // id -> transcript file path (known once any hook fires)
const streams = new Map(); // id -> { state, seq, pos, watcher, timer }
const asks = new Map();    // id -> { question, options } the session is blocked on
const live = new Set();    // ids whose PTY is running — the only ones we watch

// --- transcript ---

// Every push carries a counter, and the snapshot reports the last counter it
// contains: a client can drop the pushes that raced its fetch instead of applying an
// older copy of a message over a newer one. Same scheme as session-scrollback.
function push(id, st, messages) {
  if (!messages.length) return;
  st.seq += 1;
  sendToRenderer('transcript-data', { id, messages, seq: st.seq });
}

function readNew(id) {
  const st = streams.get(id);
  const file = paths.get(id);
  if (!st || !file) return;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    // The file was replaced or truncated under us (a `--resume` can rewrite it):
    // start over rather than reading from a position that no longer means anything.
    if (size < st.pos) {
      st.pos = 0;
      st.state = createState();
    }
    if (size === st.pos) return;
    const buf = Buffer.alloc(size - st.pos);
    const n = fs.readSync(fd, buf, 0, buf.length, st.pos);
    st.pos += n;
    push(id, st, feed(st.state, buf.toString('utf8', 0, n)));
  } catch { /* the file may not exist yet — the next hook event brings us back */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function scheduleRead(id) {
  const st = streams.get(id);
  if (!st || st.timer) return;
  st.timer = setTimeout(() => { st.timer = null; readNew(id); }, READ_DEBOUNCE_MS);
}

function startWatch(id) {
  const file = paths.get(id);
  if (!file || !live.has(id)) return;
  let st = streams.get(id);
  // A different file means a different conversation — nothing about the old one
  // (messages, read position) means anything against it.
  if (st && st.file !== file) { stopWatch(id, { keepMessages: false }); st = null; }
  if (!st) {
    st = { state: createState(), seq: 0, pos: 0, watcher: null, timer: null, file };
    streams.set(id, st);
  }
  if (st.watcher) return; // already tailing it
  readNew(id); // catch up on whatever is in the file already, then follow it
  try {
    st.watcher = fs.watch(file, () => scheduleRead(id));
  } catch { /* no watcher: hook events still poke us, so the chat only lags a little */ }
}

function stopWatch(id, { keepMessages = true } = {}) {
  const st = streams.get(id);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  try { st.watcher?.close(); } catch {}
  st.watcher = null;
  st.timer = null;
  if (!keepMessages) streams.delete(id);
}

// --- the question the TUI is blocked on ---

function setAsk(id, ask) {
  const prev = asks.get(id);
  if (!ask && !prev) return;
  if (ask && prev && prev.question === ask.question && prev.options.length === ask.options.length) return;
  if (ask) asks.set(id, ask); else asks.delete(id);
  sendToRenderer('session-ask', { id, ask: ask || null });
}

// Sessions a hook has told us are waiting for the user.
const pendingAsk = new Set();
const askTimers = new Map();

function scheduleAsk(id, getTail) {
  if (askTimers.has(id)) return;
  askTimers.set(id, setTimeout(() => {
    askTimers.delete(id);
    // The state can settle while we wait — don't announce a question that's answered.
    if (!pendingAsk.has(id)) return;
    setAsk(id, parseAsk(String(getTail() || '').slice(-ASK_TAIL_CHARS)));
  }, ASK_DEBOUNCE_MS));
}

// --- the seams sessions.js drives ---

// A hook payload named the session's transcript file. Every hook carries it, so this
// is called constantly; only a *change* does any work.
function noteTranscript(id, file) {
  if (!file || paths.get(id) === file) return;
  paths.set(id, file);
  startWatch(id);
}

function ptyStarted(id) {
  live.add(id);
  // A resumed session already has a path from its previous run; a new one gets one
  // the moment its SessionStart hook lands.
  startWatch(id);
}

// The PTY exited (or the session was archived). Stop tailing, but keep the messages:
// the conversation is still worth reading, and the file is still on disk for a
// client that asks after a restart.
function ptyStopped(id) {
  live.delete(id);
  stopWatch(id);
  pendingAsk.delete(id);
  setAsk(id, null);
}

// The session is gone for good.
function forget(id) {
  ptyStopped(id);
  streams.delete(id);
  paths.delete(id);
}

// The session's status dot changed. `needs-input` is the one state that means the TUI
// is asking something; any other state means whatever it asked has been answered.
function onState(id, state, getTail) {
  if (state === 'needs-input') {
    pendingAsk.add(id);
    scheduleAsk(id, getTail);
  } else {
    pendingAsk.delete(id);
    setAsk(id, null);
  }
}

// PTY output while the session is blocked: the box is being drawn (or redrawn with a
// different option selected). Nothing to do otherwise — the chat comes from the
// transcript, not from this stream.
function onPtyData(id, getTail) {
  if (pendingAsk.has(id)) scheduleAsk(id, getTail);
}

// The transcript path is persisted with the session so an archived one can still be
// read back after a restart, when no hook has fired for it.
const transcriptPath = (id) => paths.get(id) || '';

// --- channels ---

// Everything a client needs to render the conversation: the messages so far, the
// counter to reconcile live pushes against, and the question it's blocked on.
// A session that isn't running has no stream — read its file straight off disk.
bridgeHandle('session-transcript', async (_e, id) => {
  const st = streams.get(id);
  if (st) return { messages: st.state.msgs, seq: st.seq, ask: asks.get(id) || null };
  const file = paths.get(id);
  if (!file) return { messages: [], seq: 0, ask: null };
  try {
    const text = await fsp.readFile(file, 'utf8');
    return { messages: parseTranscript(text).slice(-MAX_MESSAGES), seq: 0, ask: null };
  } catch {
    return { messages: [], seq: 0, ask: null };
  }
});

// The commands the composer autocompletes after "/": Claude Code's own, plus the
// markdown ones in the project's and the user's .claude/commands.
async function readCommands(dir, source) {
  const out = [];
  const walk = async (rel) => {
    let entries;
    try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { await walk(child); continue; }
      if (!e.name.toLowerCase().endsWith('.md')) continue;
      let text = '';
      try { text = await fsp.readFile(path.join(dir, child), 'utf8'); } catch { continue; }
      out.push({ name: commandName(child), description: commandDescription(text), source });
    }
  };
  await walk('');
  return out;
}

bridgeHandle('list-slash-commands', async () => {
  const repo = getRepoPath();
  const user = await readCommands(path.join(os.homedir(), '.claude', 'commands'), 'user');
  const project = repo ? await readCommands(path.join(repo, '.claude', 'commands'), 'project') : [];
  return mergeCommands(BUILTIN, user, project);
});

// An image the user attached in the chat. It lands in a temp folder and Claude is
// given its path — the phone can't hand it a photo any other way, and writing it
// into the project would put a stray file in the user's working tree.
const ATTACH_DIR = path.join(os.tmpdir(), 'ide-chat-attachments');

bridgeHandle('save-attachment', async (_e, { name, data } = {}) => {
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('empty attachment');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error('attachment too large');
  // basename() alone: a name from the network must not be able to point anywhere but
  // into the attachment folder.
  const safe = path.basename(String(name || 'image.jpg')).replace(/[^\w.-]/g, '_').slice(-64);
  await fsp.mkdir(ATTACH_DIR, { recursive: true });
  const file = path.join(ATTACH_DIR, `${Date.now()}-${safe}`);
  await fsp.writeFile(file, buf);
  return { path: file };
});

module.exports = {
  noteTranscript, ptyStarted, ptyStopped, forget, onState, onPtyData, transcriptPath,
};
