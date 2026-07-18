// Wire protocol for remote (mobile) clients. Pure logic — no Electron, no
// sockets — so it can run in the desktop app today and a cloud relay later.
// Messages are single JSON objects; `ch`/`args` mirror IPC channel names 1:1.

const PROTO_VERSION = 1;

// Channels a remote client may call. Allowlist, not blocklist: anything not
// listed here is rejected even if a handler exists (native dialogs, clipboard,
// db, runners must stay desktop-only). Phase 2 extends this with sessions,
// git, explorer and terminal channels.
const REMOTE_CHANNELS = {
  req: new Set([
    // the desktop windows running on this machine, so the phone can pick which one it
    // drives. Authed like everything else here — the relay never sees this list, and
    // an open project's path is not something to hand out before a device proves itself.
    'list-instances',
    // projects
    'get-repo-path',
    'get-recent-folders',
    'open-folder-path',
    'remove-recent-folder',
    // claude sessions
    'get-sessions',
    // one page of the list, tab-filtered and searchable — what a phone lists with,
    // so a long archive is never shipped in full
    'query-sessions',
    'new-session',
    'resume-session',
    'check-claude',
    'check-codex',
    // remaining Claude subscription usage — the thin bar under the phone's header
    'get-usage',
    // retained PTY output, so a phone reopening a session sees its scrollback
    'session-scrollback',
    // the session as a *conversation* — what the phone renders instead of a terminal:
    // the messages from Claude's own transcript, the prompt it is blocked on, the
    // commands its composer autocompletes, and the images attached to a message.
    'session-transcript',
    'send-prompt',
    // the answer to a question the TUI is drawing: the option's keystroke, and the
    // text the "tell Claude what to do differently"/"Other" option asks for
    'answer-ask',
    'list-slash-commands',
    'save-attachment',
    // git
    'git-is-repo',
    'git-status',
    'git-branches',
    'git-checkout',
    'git-create-branch',
    'git-delete-branch',
    'git-stage',
    'git-unstage',
    'git-diff',
    'git-revert',
    'git-commit',
    'git-undo',
    'git-push',
    'git-fetch',
    'git-pull',
    'git-log',
    'git-commit-diff',
    'git-revert-commit',
    'git-undo-commit',
    'git-stash-list',
    'git-stash-push',
    'git-stash-show',
    'git-stash-apply',
    'git-stash-pop',
    'git-stash-drop',
    // per-session commit
    'session-diff',
    'session-diff-stat',
    'commit-session',
    'revert-session',
    // files
    'list-dir',
    'list-files',
    'search-names',
    'search-refs',
    'read-text',
    // binary bytes as base64. The phone pulls an .apk over read-asset-chunk (one
    // byte range per frame, staying under the relay's frame cap) before handing it
    // to Android's package installer; read-asset ships a whole file in one frame.
    'read-asset',
    'read-asset-chunk',
    // hands back a LAN HTTP URL for a repo .apk, so the phone can stream the whole
    // file to disk with downloadAsync instead of reassembling it from base64.
    'apk-http-url',
    'write-text',
    'create-file',
    'create-folder',
    'rename-file',
    'delete-file',
    // terminals
    'term-shells',
    'term-create',
    'term-restart',
    'term-list',
    'term-scrollback',
    // run configs (.vscode/launch.json + tasks.json). Starting/stopping goes
    // through the desktop, which owns the terminal tabs — see run-configs.js.
    'get-run-configs',
    'run-config-start',
    'run-config-stop',
    // the phone registering (or clearing) its Expo push token, so the desktop can
    // notify it of completed sessions while the app holds no socket — see push.js
    'register-push',
    // custom models (Ollama): a phone can *list* installed models to populate its
    // model picker, but cannot install/remove them — the management channels
    // (ollama-ensure/pull/cancel-pull/remove/remove-all) are deliberately absent.
    'ollama-list',
    // remote browser: an offscreen browser window on the desktop, streamed to the
    // phone as JPEG frames (see src/main/remote-browser.js). A req, not a send, so
    // the phone knows the window is up before it starts watching frames.
    'browser-open',
    // remote desktop control: the whole screen streamed to the phone as JPEG
    // frames, phone input injected at OS level (see src/main/remote-control.js).
    // A req so the phone learns the screen size and whether injection is
    // available before it starts watching frames. Auth-gated like everything
    // here — a paired phone already holds terminal access, so this is the same
    // trust tier, not an escalation.
    'control-open',
    // system audio streamed as webm/opus chunks (see src/main/remote-audio.js).
    // A req so the phone learns whether capture is supported before watching.
    'audio-open',
  ]),
  send: new Set([
    // which model runs the session, and how hard it thinks — retargeted live from the
    // phone's chat, exactly as the desktop's session-bar badge does it
    'set-session-model',
    'set-session-effort',
    'pty-input',
    'pty-resize',
    'kill-session',
    'suspend-session',
    'term-input',
    'term-resize',
    'term-kill',
    // remote browser control (fire-and-forget): navigation, batched input events,
    // viewport resize, back/forward/reload/stop, teardown.
    'browser-navigate',
    'browser-input',
    'browser-resize',
    'browser-nav',
    'browser-close',
    // remote desktop control (fire-and-forget): batched OS input events, teardown.
    'control-input',
    // zoom viewport: which sub-rect of the display to stream, and at what size
    'control-region',
    'control-close',
    'audio-close',
  ]),
};

// Renderer-push channels forwarded to remote clients.
const REMOTE_EVENTS = new Set([
  'folder-changed',
  'pty-data',
  'status',
  'session-meta',
  'sessions-changed',
  // new/updated chat messages, and the question the TUI is blocked on (see chat.js)
  'transcript-data',
  'session-ask',
  'session-name',
  'session-error',
  'term-data',
  'term-exit',
  // the PTY's dimensions changed (desktop resize or restart) — an attached phone
  // mirrors them, since the byte stream is painted for exactly that geometry
  'term-resized',
  // the open terminals changed (opened/closed/restarted) — also how a phone tells
  // which launch configs are running, and 'run-configs-changed' when the .vscode
  // files themselves are edited
  'terminals-changed',
  'run-configs-changed',
  'session-evicted',
  'session-model',
  'session-effort',
  'tree-changed',
  // the desktop installed/removed a model — phones refresh their picker
  'ollama-models-changed',
  // remote browser: viewport JPEG frames (watched stream) and page state
  // (url/title/loading/canGoBack/canGoForward — small, broadcast).
  'browser-frame',
  'browser-state',
  // remote desktop control: whole-screen JPEG frames (watched stream).
  'screen-frame',
  // system audio: webm/opus chunks (watched stream).
  'audio-chunk',
]);

// The high-volume per-session streams among REMOTE_EVENTS. A client that has sent a
// `watch` frame receives one of these only for the ids it watches — a phone reading a
// chat must not have it queue behind every other session's terminal bytes on the one
// relay socket. A client that never sends `watch` (an older app) gets everything, as
// before.
const STREAM_EVENTS = new Set(['pty-data', 'term-data', 'transcript-data', 'browser-frame', 'screen-frame', 'audio-chunk']);

const ERR = {
  BAD_MESSAGE: 'bad-message',
  NOT_AUTHED: 'not-authed',
  BAD_TOKEN: 'bad-token',
  CHANNEL_DENIED: 'channel-denied',
  HANDLER_ERROR: 'handler-error',
  UNKNOWN_CHANNEL: 'unknown-channel',
};

// Parse one ws frame into a validated message or null. Shape errors never
// throw — a malformed frame from the network is expected input, not a bug.
function parseMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'pair':
      return typeof msg.pairToken === 'string' && typeof msg.deviceName === 'string' ? msg : null;
    case 'auth':
      return typeof msg.deviceToken === 'string' ? msg : null;
    case 'req':
      return (typeof msg.id === 'number' || typeof msg.id === 'string') && typeof msg.ch === 'string' ? msg : null;
    case 'send':
      return typeof msg.ch === 'string' ? msg : null;
    case 'watch':
      // Opt in/out of one stream: `{ch, id, on}` — the channel must be a stream
      // event, the id names the session/terminal, `on: false` unsubscribes.
      return typeof msg.ch === 'string' && typeof msg.id === 'string' && typeof msg.on === 'boolean' ? msg : null;
    case 'fwd-open':
    case 'fwd-close':
      // `path` (fwd-open, optional) is the page to land on; the desktop is what
      // decides whether it is a path at all — see normalizeForwardPath.
      if (msg.path !== undefined && typeof msg.path !== 'string') return null;
      return Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536 ? msg : null;
    default:
      return null;
  }
}

const hello = () => ({ t: 'hello', protoVersion: PROTO_VERSION });
const paired = (deviceToken, deviceId) => ({ t: 'paired', deviceToken, deviceId });
const authOk = (deviceId, appVersion) => ({ t: 'auth-ok', deviceId, appVersion });
const authErr = (code) => ({ t: 'auth-err', code });
const resOk = (id, result) => ({ t: 'res', id, ok: true, result });
const resErr = (id, error) => ({ t: 'res', id, ok: false, error });
const ev = (ch, payload) => ({ t: 'ev', ch, payload });
const fwdOk = (port, url) => ({ t: 'fwd-ok', port, url });
const fwdErr = (port, error) => ({ t: 'fwd-err', port, error });

const canCall = (kind, ch) => REMOTE_CHANNELS[kind] ? REMOTE_CHANNELS[kind].has(ch) : false;
const isRemoteEvent = (ch) => REMOTE_EVENTS.has(ch);
const isStreamEvent = (ch) => STREAM_EVENTS.has(ch);

// Largest response frame the desktop will put on the relay socket. Kept under the
// relay's 16MB ws maxPayload with headroom for framing: an oversized frame is
// rejected by the receiver, and pre-fix relays crash outright on one.
const MAX_RES_BYTES = 12 * 1024 * 1024;

module.exports = {
  PROTO_VERSION, REMOTE_CHANNELS, REMOTE_EVENTS, STREAM_EVENTS, ERR, MAX_RES_BYTES,
  parseMessage, hello, paired, authOk, authErr, resOk, resErr, ev, fwdOk, fwdErr,
  canCall, isRemoteEvent, isStreamEvent,
};
