// Per-project settings: a plain `{ [projectPath]: { ...flags } }` map. Pure data
// helpers, no electron/IO, so they're unit-tested directly; the file store and
// IPC live in project-settings.js.
//
// These are settings main must know *before* the renderer is ready (session
// creation reads useWorktrees), so they can't live in renderer localStorage —
// which is also last-instance-wins across concurrent instances (see instance.js).

// Every known key with its default. Unknown keys in the file are dropped on load
// so a downgrade can't resurrect a setting the code no longer honours.
const DEFAULTS = {
  useWorktrees: false,
};

// Drop anything that isn't a `path -> { knownBooleanKey: bool }` entry: the file
// is hand-editable and survives version changes, so treat it as untrusted.
function sanitizeMap(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [repo, value] of Object.entries(parsed)) {
    if (!repo || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof value[key] === 'boolean') entry[key] = value[key];
    }
    if (Object.keys(entry).length) out[repo] = entry;
  }
  return out;
}

// Settings for one project, defaults filled in. An unknown project is all-defaults.
function projectSettings(map, repo) {
  return { ...DEFAULTS, ...((map && repo && map[repo]) || {}) };
}

// Set one flag, returning a NEW map. A value back at its default drops the key
// (and an emptied entry drops the project) so the file doesn't accumulate noise
// for every folder the user ever opened.
function withProjectSetting(map, repo, key, value) {
  if (!repo || !(key in DEFAULTS) || typeof value !== 'boolean') return map || {};
  const next = { ...(map || {}) };
  const entry = { ...(next[repo] || {}) };
  if (value === DEFAULTS[key]) delete entry[key];
  else entry[key] = value;
  if (Object.keys(entry).length) next[repo] = entry;
  else delete next[repo];
  return next;
}

module.exports = { DEFAULTS, sanitizeMap, projectSettings, withProjectSetting };
