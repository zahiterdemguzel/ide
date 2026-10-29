// Mirror every localStorage write to the persistent settings file
// (main/settings-store.js), so a setting survives a crash or force-quit instead
// of only a clean quit. Imported first from index.js so no module writes before
// the hooks are in place. Wraps Storage.prototype (not each caller) because
// settings are written from dozens of modules, all through setItem/removeItem.

const FLUSH_DELAY_MS = 200; // coalesces bursts like a splitter drag into one write

const api = window.api;
let pendingSet = {};
let pendingRemoved = new Set();
let flushTimer = null;

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!Object.keys(pendingSet).length && !pendingRemoved.size) return;
  api.settingsStoreChanges({ set: pendingSet, removed: [...pendingRemoved] });
  pendingSet = {};
  pendingRemoved = new Set();
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function recordSet(key, value) {
  pendingRemoved.delete(key);
  pendingSet[key] = value;
  scheduleFlush();
}

function recordRemove(key) {
  delete pendingSet[key];
  pendingRemoved.add(key);
  scheduleFlush();
}

function snapshot() {
  const all = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    all[key] = localStorage.getItem(key);
  }
  return all;
}

if (api?.settingsStoreChanges) {
  const proto = Storage.prototype;
  const { setItem, removeItem, clear } = proto;
  proto.setItem = function (key, value) {
    setItem.call(this, key, value);
    if (this === localStorage) recordSet(String(key), String(value));
  };
  proto.removeItem = function (key) {
    removeItem.call(this, key);
    if (this === localStorage) recordRemove(String(key));
  };
  proto.clear = function () {
    const keys = this === localStorage ? Object.keys(snapshot()) : [];
    clear.call(this);
    for (const key of keys) recordRemove(key);
  };

  // Main ignores the seed once the file exists; on the first run after upgrading
  // it adopts the settings the old quit-time copy restored.
  api.settingsStoreSeed(snapshot());
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}
