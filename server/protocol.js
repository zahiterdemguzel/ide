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
    // projects
    'get-repo-path',
    'get-recent-folders',
    'open-folder-path',
    'remove-recent-folder',
    // claude sessions
    'get-sessions',
    'new-session',
    'resume-session',
    'check-claude',
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
    'write-text',
    'create-file',
    'create-folder',
    'rename-file',
    'delete-file',
    // terminals
    'term-shells',
    'term-create',
    'term-restart',
  ]),
  send: new Set([
    'pty-input',
    'pty-resize',
    'kill-session',
    'suspend-session',
    'term-input',
    'term-resize',
    'term-kill',
  ]),
};

// Renderer-push channels forwarded to remote clients.
const REMOTE_EVENTS = new Set([
  'folder-changed',
  'pty-data',
  'status',
  'session-meta',
  'session-name',
  'session-error',
  'term-data',
  'term-exit',
  'session-evicted',
  'session-model',
  'tree-changed',
]);

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
    case 'fwd-open':
    case 'fwd-close':
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

module.exports = {
  PROTO_VERSION, REMOTE_CHANNELS, REMOTE_EVENTS, ERR,
  parseMessage, hello, paired, authOk, authErr, resOk, resErr, ev, fwdOk, fwdErr,
  canCall, isRemoteEvent,
};
