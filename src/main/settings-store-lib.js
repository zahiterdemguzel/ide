// Pure logic behind settings-store.js: the renderer's localStorage mirrored into
// a JSON file in the shared data dir, as a flat { key: stringValue } map.

// A hand-edited or truncated file must degrade to "no settings", never throw, and
// anything that isn't a string value is dropped (localStorage only holds strings).
function normalizeStore(raw) {
  const store = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') store[key] = value;
  }
  return store;
}

// Apply one batch of renderer writes ({ set: {key: value}, removed: [key] }) on top
// of the store. Applied per key onto whatever is on disk, so two windows changing
// different settings both keep their change instead of the last writer's whole
// snapshot winning.
function applyChanges(store, changes) {
  const next = { ...normalizeStore(store) };
  const { set, removed } = changes || {};
  if (Array.isArray(removed)) {
    for (const key of removed) if (typeof key === 'string') delete next[key];
  }
  Object.assign(next, normalizeStore(set));
  return next;
}

module.exports = { normalizeStore, applyChanges };
