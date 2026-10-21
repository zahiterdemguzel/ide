const path = require('path');

// Claude Code shows a "Do you trust this folder?" dialog the first time it runs
// in a folder, and remembers the answer per folder in ~/.claude.json under
// `projects[<dir>].hasTrustDialogAccepted`. A folder is also trusted when any
// ancestor is. The IDE pre-accepts it for the folder a session spawns in, so a
// new session (and especially a fresh worktree, a new path every time) starts
// straight into the prompt instead of that dialog.

// Claude Code keys `projects` by the normalized path with forward slashes, on
// Windows too.
function trustKey(dir, platform = process.platform) {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  return flavor.normalize(dir).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

function ancestorKeys(key) {
  const keys = [key];
  let current = key;
  for (;;) {
    const cut = current.lastIndexOf('/');
    if (cut < 0) break;
    // Keep the root itself as "/" (POSIX) or "C:/" (Windows), never "".
    const parent = cut === 0 || /^[A-Za-z]:$/.test(current.slice(0, cut))
      ? current.slice(0, cut + 1)
      : current.slice(0, cut);
    if (parent === current) break;
    keys.push(parent);
    current = parent;
  }
  return keys;
}

function isFolderTrusted(config, dir, platform) {
  const projects = (config && config.projects) || {};
  return ancestorKeys(trustKey(dir, platform))
    .some((key) => projects[key] && projects[key].hasTrustDialogAccepted === true);
}

// Returns the config with `dir` marked trusted, or null when it already is (so
// the caller can skip rewriting a file other Claude processes also write).
function withFolderTrusted(config, dir, platform) {
  if (isFolderTrusted(config, dir, platform)) return null;
  const key = trustKey(dir, platform);
  const projects = { ...(config.projects || {}) };
  projects[key] = { ...(projects[key] || {}), hasTrustDialogAccepted: true };
  return { ...config, projects };
}

module.exports = { trustKey, isFolderTrusted, withFolderTrusted };
