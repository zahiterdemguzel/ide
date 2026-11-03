// Pure path math behind tappable file paths in the phone's chat (chat-links.js does
// the disk checks). The phone over-matches — any token with a separator or a file
// extension — and the desktop decides which of those are real files the Files
// viewer can open. A path is only linkable when it lands inside the open folder,
// because that is the only tree the phone's file channels can read.
const path = require('path');

// More than any one screen of chat mentions; the cap only stops a hostile or
// runaway request from turning into thousands of stats.
const MAX_CANDIDATES = 300;

// `src/a.js:12:3`, `src/a.js:12`, and GitHub-style `src/a.js#L12` all point at a line.
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;

function splitLocation(token) {
  const m = LINE_SUFFIX.exec(token);
  if (!m) return { file: token, line: 0 };
  return { file: token.slice(0, m.index), line: Number(m[1] || m[2]) || 0 };
}

// Prose wraps paths in quotes, brackets and sentence punctuation; none of it is
// part of the name.
function trimDecoration(token) {
  return String(token || '').trim()
    .replace(/^[`'"(<[{]+/, '')
    .replace(/[`'")>\]},;!?.:]+$/, '');
}

// The absolute path a chat token names, or null when it can't be a local file.
// Relative tokens resolve against the session's own tree (Claude's paths are
// relative to where it runs, which for a worktree session is not the open folder).
function candidatePath(token, { cwd, home }) {
  const { file, line } = splitLocation(trimDecoration(token));
  if (!file || /^[a-z][\w+.-]*:\/\//i.test(file)) return null;
  let abs;
  if (file === '~' || file.startsWith('~/') || file.startsWith('~\\')) {
    if (!home) return null;
    abs = path.join(home, file.slice(1));
  } else if (path.isAbsolute(file)) {
    abs = path.normalize(file);
  } else {
    if (!cwd) return null;
    abs = path.resolve(cwd, file);
  }
  return { abs, line };
}

// `abs` as a forward-slash path relative to the open folder, or null when it sits
// outside it (or is the folder itself).
function openFolderRelative(abs, repoPath) {
  if (!abs || !repoPath) return null;
  const rel = path.relative(repoPath, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Unique, non-empty string tokens, capped.
function normalizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const t of list) {
    if (typeof t !== 'string' || !t.trim() || t.length > 1024) continue;
    seen.add(t);
    if (seen.size >= MAX_CANDIDATES) break;
  }
  return [...seen];
}

module.exports = { MAX_CANDIDATES, splitLocation, trimDecoration, candidatePath, openFolderRelative, normalizeCandidates };
