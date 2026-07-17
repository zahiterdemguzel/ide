// The chat view of a Claude session — what the phone renders instead of a terminal.
//
// Three things a conversation needs that a PTY stream doesn't give you:
//
//  - the messages. Claude Code appends every turn, tool call and result to its own
//    JSONL transcript; its path arrives on every hook payload, so sessions.js hands
//    it here and we tail the file. transcript-lib.js turns the bytes into messages.
//  - the question it is blocked on. Claude's multiple-choice questions and permission
//    prompts are drawn *in the TUI*, and the transcript won't have them until they're
//    answered — so a chat that ignored them would sit there looking idle. They are not
//    read off the terminal (see ask-lib.js: an Ink repaint leaves nothing readable);
//    they are lifted from the hook payload that announces them.
//  - the slash commands and image attachments the composer needs.
//
// Everything stateful here is keyed by session id and torn down with the session.
// The pure halves live in transcript-lib.js / ask-lib.js / slash-commands-lib.js.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { handle: bridgeHandle } = require('./remote-bridge');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { createState, feed, parseTranscript, MAX_MESSAGES } = require('./transcript-lib');
const { fromHook, clearsAsk } = require('./ask-lib');
const { BUILTIN, commandName, commandDescription, mergeCommands } = require('./slash-commands-lib');

// Claude writes a turn as one appended line, so a short debounce coalesces the burst
// of writes a single message makes without making the chat feel laggy.
const READ_DEBOUNCE_MS = 80;
// A new session is handed its transcript path before Claude has created the file;
// this is how often we look for it to appear.
const WATCH_RETRY_MS = 500;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const paths = new Map();   // id -> transcript file path (known once any hook fires)
const streams = new Map(); // id -> { state, seq, pos, watcher, timer }
const asks = new Map();    // id -> the question the session is blocked on
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
    st = { state: createState(), seq: 0, pos: 0, watcher: null, timer: null, retry: null, file };
    streams.set(id, st);
  }
  if (st.watcher) return; // already tailing it
  readNew(id); // catch up on whatever is in the file already, then follow it
  try {
    st.watcher = fs.watch(file, () => scheduleRead(id));
  } catch {
    // The file isn't there yet. A session started from scratch is told its transcript
    // path (by its very first hook) before Claude has written a line to it, so this is
    // the normal case for a new session — not an error. Keep trying: without this the
    // conversation would never be tailed at all, and its chat would stay empty for good.
    if (!st.retry) st.retry = setTimeout(() => { st.retry = null; startWatch(id); }, WATCH_RETRY_MS);
  }
}

function stopWatch(id, { keepMessages = true } = {}) {
  const st = streams.get(id);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  if (st.retry) clearTimeout(st.retry);
  try { st.watcher?.close(); } catch {}
  st.watcher = null;
  st.timer = null;
  st.retry = null;
  if (!keepMessages) streams.delete(id);
}

// --- the question the TUI is blocked on ---

function setAsk(id, ask) {
  if (!ask && !asks.has(id)) return;
  if (ask) asks.set(id, ask); else asks.delete(id);
  sendToRenderer('session-ask', { id, ask: ask || null });
}

// --- the seams sessions.js drives ---

// A hook payload named the session's transcript file. Every hook carries it, so this
// is called constantly — and deliberately does its work every time, not only when the
// path changes: startWatch is a no-op once the file is being tailed, but if the file
// didn't exist yet (a session started from scratch), this is a second chance to pick
// it up without waiting for the retry timer.
function noteTranscript(id, file) {
  if (!file) return;
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
  setAsk(id, null);
}

// The session is gone for good.
function forget(id) {
  ptyStopped(id);
  streams.delete(id);
  paths.delete(id);
}

// A hook fired. It is the only thing that can tell us the session has started asking
// something — and, just as importantly, that it has stopped: a prompt answered at the
// desktop's own terminal produces no other signal, and a card left behind on the phone
// would be a question nobody is waiting for an answer to.
function onHook(id, payload, family) {
  const ask = fromHook(payload, family);
  if (ask) setAsk(id, ask);
  else if (clearsAsk(payload)) setAsk(id, null);
}

// The question the session is blocked on, for the client that fetches a snapshot and
// for the handler that turns an answer into keystrokes.
const currentAsk = (id) => asks.get(id) || null;

// The user answered. The box is settled the instant the keystrokes go out — the hook
// that confirms it lands later, and a card that lingered until then would invite a
// second answer into a menu that has already moved on.
const clearAsk = (id) => setAsk(id, null);

// The transcript path is persisted with the session so an archived one can still be
// read back after a restart, when no hook has fired for it.
const transcriptPath = (id) => paths.get(id) || '';

// --- channels ---

// Everything a client needs to render the conversation: the messages so far, the
// counter to reconcile live pushes against, and the question it's blocked on.
// A session that isn't running has no stream — read its file straight off disk.
bridgeHandle('session-transcript', async (_e, id) => {
  const st = streams.get(id);
  if (st) return { messages: st.state.msgs, seq: st.seq, ask: currentAsk(id) };
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
  noteTranscript, ptyStarted, ptyStopped, forget, onHook, currentAsk, clearAsk, transcriptPath,
};
