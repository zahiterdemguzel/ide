const http = require('http');
const { sendToRenderer } = require('./window');
// Pure event->state mapping, resume-downgrade rule, and settings JSON live in the
// Electron-free sibling so they stay unit-tested (see test/hook-events.test.js).
const { deriveStatus, shouldApplyState, hooksSettings: buildHooksSettings } = require('./hook-events');
const { statusLineCommand } = require('./statusline');
// Runtime-only seam: the request handler calls into sessions, and sessions calls
// hooksSettings()/getHookPort() here — both happen well after module load, so the
// circular require is safe. Access via the module object, never destructure at top.
const sessions = require('./sessions');

let hookPort = 0;
const getHookPort = () => hookPort;

// Per-session subagent bookkeeping for deriveStatus: { subagents, mainStopped }.
// In-memory only — nothing is running across a restart, so there's nothing to
// persist. Keyed by session_id; reset each turn by deriveStatus itself.
const subagentTracking = new Map();
const getTracking = (id) => subagentTracking.get(id) || { subagents: 0, mainStopped: false };

// --- hooks injected per session via `claude --settings <json>` ---
// Every event posts its raw stdin payload to our local server, which derives
// state from hook_event_name. Bound to the live server port at spawn time.
const hooksSettings = () => buildHooksSettings(hookPort, statusLineCommand());

function startHookServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.end('ok'); return; } // ignore malformed
      try {
        let state = null;
        if (payload.session_id) {
          // Subagent-aware gating: a session with background subagents still in
          // flight stays "working" through the main agent's Stop, so the finish
          // chime waits for the last agent (see deriveStatus).
          const { state: derived, tracking } = deriveStatus(payload, getTracking(payload.session_id));
          subagentTracking.set(payload.session_id, tracking);
          state = derived;
        }
        if (state && payload.session_id) {
          // Don't let a resume's SessionStart → idle wipe the meaningful colour a
          // session was reopened with (completed/pushed/interrupted); shouldApplyState
          // encodes that rule (see test/hook-events.test.js).
          const cur = sessions.getSessionState(payload.session_id);
          if (shouldApplyState(state, cur)) {
            sendToRenderer('status', { id: payload.session_id, state });
            sessions.setSessionState(payload.session_id, state); // persist so it survives a restart
          }
        }
        // Await before answering the hook: on PreToolUse this snapshots the
        // working tree, and the command hook blocks the tool from running until
        // we respond — so the "before" snapshot is guaranteed to predate the
        // tool's filesystem changes (see recordSessionActivity). Fast for every
        // other event (no git call), so the added latency is bounded to file-
        // touching tools.
        const meta = await sessions.recordSessionActivity(payload);
        if (meta) sendToRenderer('session-meta', meta);
      } catch (err) {
        // Tracking this session's activity failed — surface it instead of silently
        // losing the session's edit/commit state (and never crash the hook server).
        sessions.reportSessionError('tracking session activity', err);
      }
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
