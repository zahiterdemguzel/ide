// Which file paths mentioned in a session's chat are real files the phone can open.
// The phone sends every path-looking token it renders; this answers with the ones
// that exist inside the open folder, as the repo-relative path its Files viewer
// reads. The path math lives in chat-links-lib.js.
const fsp = require('fs/promises');
const os = require('os');
const bridge = require('./remote-bridge');
const { getRepoPath } = require('./repo');
const { sessions, sessionCwd } = require('./sessions');
const { candidatePath, openFolderRelative, normalizeCandidates } = require('./chat-links-lib');

async function isFile(abs) {
  try { return (await fsp.stat(abs)).isFile(); } catch { return false; }
}

bridge.handle('resolve-chat-paths', async (_e, { id, paths } = {}) => {
  const repoPath = getRepoPath();
  const cwd = sessionCwd(sessions.get(id));
  const home = os.homedir();
  const resolved = {};
  await Promise.all(normalizeCandidates(paths).map(async (token) => {
    const target = candidatePath(token, { cwd, home });
    const rel = target && openFolderRelative(target.abs, repoPath);
    if (rel && await isFile(target.abs)) resolved[token] = { path: rel, line: target.line };
  }));
  return { ok: true, resolved };
});
