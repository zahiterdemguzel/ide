const http = require('http');
const { execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const { sendToRenderer } = require('./window');
// Pure event->state mapping, resume-downgrade rule, and settings JSON live in the
// Electron-free sibling so they stay unit-tested (see test/hook-events.test.js).
const { deriveStatus, shouldApplyState, hooksSettings: buildHooksSettings, normalizeHookPayload, hookOriginId } = require('./hook-events');
const { statusLineCommand } = require('./statusline');
const { sanitizeContextReport } = require('./statusline-lib');
const { seenImagesFromPayload } = require('./seen-images-lib');
const { modelFamily } = require('./agent-providers');
const { processListCommand, parseProcessList, hasClaudeToolShell } = require('./background-work-lib');
// Runtime-only seam: the request handler calls into sessions, and sessions calls
// hooksSettings()/getHookPort() here — both happen well after module load, so the
// circular require is safe. Access via the module object, never destructure at top.
const sessions = require('./sessions');

let hookPort = 0;
const getHookPort = () => hookPort;

// Status-dot debugging: append every hook event and the state it derived to a
// log so the live sequence can be read back. Opt-in via IDE_HOOK_DEBUG=1 — it
// was always on, and a stat + synchronous append per hook on the main thread
// added up fast in a session with many subagents.
// Truncated once it passes DEBUG_LOG_MAX: every hook event appends a line, and
// unbounded it had already grown to tens of MB in the user's temp folder.
const DEBUG_LOG_ENABLED = process.env.IDE_HOOK_DEBUG === '1';
const DEBUG_LOG_MAX = 4 * 1024 * 1024;
const debugLog = (line) => {
  try {
    const fs = require('fs');
    const file = require('path').join(require('os').tmpdir(), 'ide-hook-debug.log');
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > DEBUG_LOG_MAX) fs.truncateSync(file, 0);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

const subagentTracking = new Map();
const getTracking = (id) => subagentTracking.get(id) || {};
// A session's PTY dying takes every agent in it down with it — drop the
// bookkeeping so a later resume (same session id) starts from a clean slate
// instead of inheriting a stale in-flight count.
function clearTracking(id) {
  subagentTracking.delete(id);
  pendingCompletions.delete(id);
}

function publishState(id, state) {
  if (state === sessions.getSessionState(id)) return;
  sendToRenderer('status', { id, state });
  sessions.setSessionState(id, state);
}

// Claude can stop its chat while a tool shell is still running. Hold completion
// until one process scan confirms the shell is gone, so we don't ring the chime
// before the release/build finishes. One scan serves all pending sessions.
const pendingCompletions = new Map();
const SHELL_CHECK_INTERVAL_MS = 2000;
const processOptions = { commandLine: true };
let shellCheckTimer;
let checkingShells = false;

function scheduleShellCheck(delay) {
  if (checkingShells || shellCheckTimer || !pendingCompletions.size) return;
  shellCheckTimer = setTimeout(checkShells, delay);
  shellCheckTimer.unref();
}

async function checkShells() {
  shellCheckTimer = null;
  if (!pendingCompletions.size) return;
  checkingShells = true;
  const pending = [...pendingCompletions];
  const { file, args } = processListCommand(process.platform, processOptions);
  let processes;
  try {
    const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    processes = parseProcessList(stdout, processOptions);
  } catch {
    // A failed listing cannot settle a shell we already observed running.
  }
  for (const [id, entry] of pending) {
    if (pendingCompletions.get(id) !== entry) continue;
    const session = sessions.sessions.get(id);
    if (session?.pty !== entry.pty || session.state !== entry.lastState) {
      pendingCompletions.delete(id);
      continue;
    }
    if (processes && hasClaudeToolShell(processes, entry.pty.pid)) {
      entry.running = true;
      entry.lastState = 'bg-agents';
      publishState(id, 'bg-agents');
    } else if (processes || !entry.running) {
      pendingCompletions.delete(id);
      publishState(id, 'completed');
    }
  }
  checkingShells = false;
  scheduleShellCheck(SHELL_CHECK_INTERVAL_MS);
}

function applyHookState(id, state) {
  const session = sessions.sessions.get(id);
  if (!session || !shouldApplyState(state, session.state)) return;
  const pty = session?.pty;
  if (state === 'completed' && Number.isInteger(pty?.pid) && modelFamily(session.model) !== 'codex') {
    const pending = pendingCompletions.get(id);
    if (pending?.pty !== pty || pending.lastState !== session.state) {
      pendingCompletions.set(id, { pty, running: false, lastState: session.state });
    }
    scheduleShellCheck(0);
    return;
  }
  pendingCompletions.delete(id);
  publishState(id, state);
}

// --- hooks injected per session via `claude --settings <json>` ---
// Every event posts its raw stdin payload to our local server, which derives
// state from hook_event_name. Bound to the live server port at spawn time.
// User toggle (Settings → General → "Track every tool call"). The renderer
// pushes the saved value on startup and on change; default on. Off narrows the
// tool hooks of the next-spawned session (see hook-events.hooksSettings) — a live
// session keeps the hooks it spawned with.
let detailedToolHooks = true;
const setDetailedToolHooks = (on) => { detailedToolHooks = !!on; };
const hooksSettings = (ideId) => buildHooksSettings(hookPort, statusLineCommand(), ideId, { detailedToolHooks });

// An image file bigger than this is skipped rather than shipped over IPC: the model
// never sees one that size anyway (Claude Code downscales what Read returns).
const MAX_SEEN_FILE_BYTES = 20 * 1024 * 1024;

// Forward every image a tool call showed the model to the session's "Seen by AI"
// panel (renderer seen-images.js) as a data URL. Temp screenshots and files
// outside the repo are as common here as project files, so the bytes travel with
// the event instead of a path the repo-scoped file viewers would refuse.
async function forwardSeenImages(payload) {
  const seen = seenImagesFromPayload(payload);
  if (!seen) return;
  const fsp = require('fs').promises;
  for (const image of seen.images) {
    let base64 = image.base64;
    if (!base64) {
      const { size } = await fsp.stat(image.filePath);
      if (size > MAX_SEEN_FILE_BYTES) continue;
      base64 = (await fsp.readFile(image.filePath)).toString('base64');
    }
    sendToRenderer('session-image', {
      id: payload.session_id, tool: seen.tool, label: seen.label, at: Date.now(),
      src: `data:${image.mimeType};base64,${base64}`,
    });
  }
}

// Last context gauge forwarded per session, so the statusLine's 2-second refresh
// only costs an IPC message when the number actually moved.
const lastContextReport = new Map();

// A session's statusLine script reporting its live context-window fill (see
// statusline-script.js reportContext). Forwarded to the session bar's badge.
function handleContextReport(ideId, body) {
  let report;
  try { report = sanitizeContextReport(JSON.parse(body)); } catch { return; }
  if (!ideId || !report) return;
  const key = JSON.stringify(report);
  if (lastContextReport.get(ideId) === key) return;
  lastContextReport.set(ideId, key);
  sendToRenderer('session-context', { id: ideId, ...report });
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/statusline') {
        handleContextReport(url.searchParams.get('ide'), body);
        res.end('{}');
        return;
      }
      let payload;
      // The BOM strip is for Codex on Windows: its hooks run through PowerShell,
      // whose stdin piping prepends a UTF-8 BOM that JSON.parse rejects.
      try { payload = JSON.parse(body.replace(/^\uFEFF/, '')); } catch { res.end('{}'); return; } // ignore malformed
      try {
        // Every hook URL carries the IDE's own session id (`?ide=`); rewrite the
        // payload to speak it, and remember the id the CLI is really running under
        // — Codex invents one (the handle `codex resume` needs), and Claude mints a
        // new one whenever the conversation forks (see normalizeHookPayload).
        const ideId = new URL(req.url, 'http://localhost').searchParams.get('ide');
        const normalized = normalizeHookPayload(payload, ideId);
        payload = normalized.payload;
        if (normalized.agentSessionId) sessions.noteAgentSessionId(ideId, normalized.agentSessionId);
        let state = null;
        if (payload.session_id) {
          // Codex generates its own ID even for the main conversation. It must
          // represent the main origin, not a Claude-style fork.
          const session = sessions.sessions.get(payload.session_id);
          const originId = hookOriginId(modelFamily(session?.model), normalized.agentSessionId);
          const opts = { originId, now: Date.now() };
          const { state: derived, tracking } = deriveStatus(payload, getTracking(payload.session_id), opts);
          subagentTracking.set(payload.session_id, tracking);
          // An ESC/Ctrl+C keystroke on its own never moves the dot — this event is
          // the trusted word on whether it actually cut the turn short.
          state = sessions.resolveInterrupt(payload, derived);
          if (DEBUG_LOG_ENABLED) debugLog(`ev=${payload.hook_event_name} tool=${payload.tool_name || '-'} agent=${payload.agent_id || '-'} origin=${normalized.agentSessionId || '-'} derived=${derived} final=${state} track=${JSON.stringify(tracking)}`);
        }
        if (state && payload.session_id) applyHookState(payload.session_id, state);
        // Await before answering the hook: on PreToolUse this snapshots the
        // working tree, and the command hook blocks the tool from running until
        // we respond — so the "before" snapshot is guaranteed to predate the
        // tool's filesystem changes (see recordSessionActivity). Fast for every
        // other event (no git call), so the added latency is bounded to file-
        // touching tools.
        const meta = await sessions.recordSessionActivity(payload);
        if (meta) sendToRenderer('session-meta', meta);
        // Not awaited: showing the image must never hold up the tool's hook reply.
        if (payload.session_id) forwardSeenImages(payload).catch((err) => console.error('[seen images]', err.message));
      } catch (err) {
        // Tracking this session's activity failed — surface it instead of silently
        // losing the session's edit/commit state (and never crash the hook server).
        sessions.reportSessionError('tracking session activity', err);
      }
      // The reply becomes the hook's stdout (curl echoes the response body), and
      // Codex parses a Stop hook's stdout as JSON — a bare "ok" fails its parse
      // and surfaces as "hook returned invalid stop hook JSON output" in the TUI.
      // `{}` (no directives) satisfies both CLIs.
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; });
}

// Attach to the existing exports object instead of replacing it: hook-server is
// required before sessions (see main/index.js), so sessions captures this object
// mid-load. Reassigning module.exports here would swap in a new object sessions
// never sees, leaving hookServer.hooksSettings undefined at spawn time.
Object.assign(module.exports, { startHookServer, getHookPort, hooksSettings, setDetailedToolHooks, clearTracking });
