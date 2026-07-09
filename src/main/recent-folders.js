// Pure logic for the "recently opened projects" list shown in the Open-folder
// reverse-combobox. Kept Electron-free so it's unit-testable; repo.js handles
// the actual file persistence and IPC.

const MAX_RECENT = 7;

// Move `folder` to the front, drop any prior duplicate, and cap the list. Empty
// or non-string entries are ignored so a bad value never poisons the list.
function addRecent(list, folder, max = MAX_RECENT) {
  const clean = Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
  if (typeof folder !== 'string' || !folder) return clean.slice(0, max);
  return [folder, ...clean.filter((p) => p !== folder)].slice(0, max);
}

// Drop `folder` from the list (used when the user deletes a recent entry). Also
// scrubs garbage so a bad value never lingers.
function removeRecent(list, folder) {
  const clean = Array.isArray(list) ? list.filter((p) => typeof p === 'string' && p) : [];
  return clean.filter((p) => p !== folder);
}

module.exports = { addRecent, removeRecent, MAX_RECENT };
