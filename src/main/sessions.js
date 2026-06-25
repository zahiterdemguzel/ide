const { ipcMain } = require('electron');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const { getWin } = require('./window');
const { getRepoPath } = require('./repo');
const { resolveClaude, runHaiku } = require('./claude');
const { editOp } = require('./edit-ops');
// Runtime-only seam: hooksSettings()/getHookPort() are called when spawning a
// session (runtime), long after both modules have loaded — safe circular require.
const hookServer = require('./hook-server');

const sessions = new Map(); // id -> { pty, edits: Map<absPath, op[]>, firstPrompt, name }

// Attribute the user's first prompt and any edited files to their session, so
// we can later commit just that session's work. Returns updated meta, or null.
function recordSessionActivity(payload) {
  const s = sessions.get(payload.session_id);
  if (!s) return null;
  let changed = false;
  if (payload.hook_event_name === 'UserPromptSubmit' && !s.firstPrompt && payload.prompt) {
    s.firstPrompt = String(payload.prompt).trim();
    generateSessionName(payload.session_id, s.firstPrompt);
    changed = true;
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const ti = payload.tool_input || {};
    const f = ti.file_path;
    if (f && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) {
      if (!s.edits.has(f)) s.edits.set(f, []);
      s.edits.get(f).push(editOp(payload.tool_name, ti));
      changed = true;
    }
  }
  return changed ? { id: payload.session_id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] } : null;
}

// Name a session from its first prompt via a one-shot Haiku call, then push
// `session-name` to the renderer.
async function generateSessionName(id, prompt) {
  // ponytail: 2000-char cap is plenty for a title; bump if titles read truncated
  const text = 'Reply with ONLY a 2-4 word title (no quotes, no trailing punctuation) '
    + 'for this coding session:\n\n' + prompt.slice(0, 2000);
  const out = await runHaiku(text, { cwd: getRepoPath() });
  if (!out) return;
  const name = out.split('\n').pop().trim().slice(0, 60);
  const s = sessions.get(id);
  const win = getWin();
  if (name && s) { s.name = name; if (win) win.webContents.send('session-name', { id, name }); }
}

ipcMain.handle('new-session', (_e, { cols, rows }) => {
  const id = crypto.randomUUID();
  const p = pty.spawn(resolveClaude(), ['--session-id', id, '--settings', hookServer.hooksSettings()], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: getRepoPath(),
    env: process.env,
  });
  p.onData((data) => { const win = getWin(); if (win) win.webContents.send('pty-data', { id, data }); });
  p.onExit(() => {
    sessions.delete(id);
    const win = getWin();
    if (win) win.webContents.send('status', { id, state: 'completed' });
  });
  sessions.set(id, { pty: p, edits: new Map(), firstPrompt: '', name: '' });
  return { id, repo: getRepoPath() };
});

ipcMain.on('pty-input', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.pty.write(data);
});
ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s) try { s.pty.resize(cols, rows); } catch { /* race on close */ }
});
ipcMain.on('kill-session', (_e, { id }) => {
  const s = sessions.get(id);
  if (s) { s.pty.kill(); sessions.delete(id); }
});

function killAllSessions() {
  for (const s of sessions.values()) try { s.pty.kill(); } catch {}
}

module.exports = { sessions, recordSessionActivity, killAllSessions };
