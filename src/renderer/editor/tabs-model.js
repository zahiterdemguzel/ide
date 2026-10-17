// The editor's open-tab list, as pure state transitions (DOM lives in tabs.js).
// Mirrors VS Code's rules:
//   - A file opened by a single click is a *preview* tab (shown in italics). The
//     next preview open replaces it in place instead of piling up tabs, so
//     browsing the tree doesn't leave a trail. Editing the file, double-clicking
//     its tab, or opening it "pinned" turns it into a normal tab.
//   - New tabs open to the right of the active one.
//   - Closing the active tab activates the most recently used remaining tab.
// State: { tabs: [{ file, preview }], active: file|null, mru: [file, …] (most recent first) }.
// Every function returns a new state and never mutates its input.

export function emptyTabs() {
  return { tabs: [], active: null, mru: [] };
}

function touch(mru, file) {
  return [file, ...mru.filter((f) => f !== file)];
}

export function openTab(state, file, { preview = false } = {}) {
  const existing = state.tabs.find((t) => t.file === file);
  if (existing) {
    const tabs = preview || !existing.preview
      ? state.tabs
      : state.tabs.map((t) => (t.file === file ? { ...t, preview: false } : t));
    return { tabs, active: file, mru: touch(state.mru, file) };
  }
  const tab = { file, preview };
  const previewIdx = preview ? state.tabs.findIndex((t) => t.preview) : -1;
  if (previewIdx !== -1) {
    // Replace the old preview tab in its slot.
    const replaced = state.tabs[previewIdx].file;
    const tabs = state.tabs.map((t, i) => (i === previewIdx ? tab : t));
    return { tabs, active: file, mru: touch(state.mru.filter((f) => f !== replaced), file) };
  }
  const activeIdx = state.tabs.findIndex((t) => t.file === state.active);
  const at = activeIdx === -1 ? state.tabs.length : activeIdx + 1;
  const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
  return { tabs, active: file, mru: touch(state.mru, file) };
}

// Add a pinned tab at the end without switching to it — for files changed in
// the background (a rename or quick fix editing other files), so their unsaved
// edits are visible and can be saved, as VS Code does.
export function addBackgroundTab(state, file) {
  if (state.tabs.some((t) => t.file === file)) return state;
  return { tabs: [...state.tabs, { file, preview: false }], active: state.active ?? file, mru: [...state.mru, file] };
}

export function pinTab(state, file) {
  if (!state.tabs.some((t) => t.file === file && t.preview)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.file === file ? { ...t, preview: false } : t)) };
}

export function activateTab(state, file) {
  if (!state.tabs.some((t) => t.file === file)) return state;
  return { ...state, active: file, mru: touch(state.mru, file) };
}

export function closeTab(state, file) {
  if (!state.tabs.some((t) => t.file === file)) return state;
  const tabs = state.tabs.filter((t) => t.file !== file);
  const mru = state.mru.filter((f) => f !== file);
  let active = state.active;
  if (active === file) active = mru.find((f) => tabs.some((t) => t.file === f)) || (tabs[0] && tabs[0].file) || null;
  return { tabs, active, mru };
}

// Files to the right of / other than `file`, for the tab context menu.
export function filesToRight(state, file) {
  const idx = state.tabs.findIndex((t) => t.file === file);
  return idx === -1 ? [] : state.tabs.slice(idx + 1).map((t) => t.file);
}

export function otherFiles(state, file) {
  return state.tabs.filter((t) => t.file !== file).map((t) => t.file);
}

// Drag-and-drop reorder: move `file` so it sits at index `to`.
export function moveTab(state, file, to) {
  const from = state.tabs.findIndex((t) => t.file === file);
  if (from === -1) return state;
  const tabs = state.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
  return { ...state, tabs };
}

// A file renamed/moved in the explorer keeps its tab (and place) under the new path.
export function renameTab(state, oldFile, newFile) {
  if (!state.tabs.some((t) => t.file === oldFile)) return state;
  const swap = (f) => (f === oldFile ? newFile : f);
  return {
    tabs: state.tabs.map((t) => ({ ...t, file: swap(t.file) })),
    active: swap(state.active),
    mru: state.mru.map(swap),
  };
}

// The tab `dir` steps (+1 right, -1 left) from the active one, wrapping.
export function neighborTab(state, dir) {
  if (!state.tabs.length) return null;
  const idx = state.tabs.findIndex((t) => t.file === state.active);
  const next = (idx + dir + state.tabs.length) % state.tabs.length;
  return state.tabs[next].file;
}
