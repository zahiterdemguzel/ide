const http = require('http');
const { sendToRenderer } = require('./window');
// Runtime-only seam: the request handler calls into sessions, and sessions calls
// hooksSettings()/getHookPort() here — both happen well after module load, so the
// circular require is safe. Access via the module object, never destructure at top.
const sessions = require('./sessions');

let hookPort = 0;
const getHookPort = () => hookPort;

// --- hooks injected per session via `claude --settings <json>` ---
// Every event posts its raw stdin payload to our local server, which derives
// state from hook_event_name. Same command for all events keeps this trivial.
function hooksSettings() {
  const cmd = `curl -s -X POST http://127.0.0.1:${hookPort}/hook -d @-`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }];
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop'];
  const hooks = {};
  for (const e of events) hooks[e] = entry; // unknown events simply never fire
  return JSON.stringify({ hooks });
}

function eventToState(payload) {
  switch (payload.hook_event_name) {
    case 'Stop': return 'completed';
    case 'Notification':
    case 'PermissionRequest': return 'needs-input';
    case 'PostToolUse': {
      const c = payload.tool_input && payload.tool_input.command;
      if (c && /git\s+push/.test(c)) return 'pushed';
      return 'working';
    }
    // A session that has only just started has no work in flight yet — it sits
    // idle (gray) until the user submits the first prompt. Yellow ("working") is
    // reserved for an agent actively responding.
    case 'SessionStart': return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse': return 'working';
    default: return null;
  }
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const state = eventToState(payload);
        if (state && payload.session_id) {
          sendToRenderer('status', { id: payload.session_id, state });
        }
        // Await before answering the hook: on PreToolUse this snapshots the
        // working tree, and the command hook blocks the tool from running until
        // we respond — so the "before" snapshot is guaranteed to predate the
        // tool's filesystem changes (see recordSessionActivity). Fast for every
        // other event (no git call), so the added latency is bounded to file-
        // touching tools.
        const meta = await sessions.recordSessionActivity(payload);
        if (meta) sendToRenderer('session-meta', meta);
      } catch { /* ignore malformed */ }
      res.end('ok');
    });
  });
  server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; });
}

// Attach to the existing exports object instead of replacing it: hook-server is
// required before sessions (see main/index.js), so sessions captures this object
// mid-load. Reassigning module.exports here would swap in a new object sessions
// never sees, leaving hookServer.hooksSettings undefined at spawn time.
Object.assign(module.exports, { startHookServer, getHookPort, hooksSettings });
