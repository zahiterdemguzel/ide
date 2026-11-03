// A Map whose keys stay in memory but whose values live on disk until something
// reads them. An archived session's text-edit ops (`s.edits`) are the bulk of its
// record — whole file contents for every Write — and nothing reads them until the
// session is committed, reverted or resumed. Keeping only the paths in memory lets
// hundreds of archived sessions cost almost nothing while staying committable.
//
// Key-only operations (has/keys/size/delete/clear) never touch the disk, so the
// tracked-file list and "does another session own this path" checks stay free.
// Anything that needs a value (get/set/values/entries/iteration) loads the stored
// ops once via `loadValues()` (a Map of key -> value), after which this behaves
// exactly like a plain Map. A key deleted before the load stays deleted.
class DiskBackedMap extends Map {
  constructor(keys, loadValues, missingValue = () => []) {
    super();
    for (const key of keys) super.set(key, undefined);
    this.loadValues = loadValues;
    this.missingValue = missingValue;
    this.loaded = false;
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    let stored = null;
    try { stored = this.loadValues(); } catch { stored = null; }
    for (const key of super.keys()) {
      const value = stored ? stored.get(key) : undefined;
      super.set(key, value === undefined ? this.missingValue() : value);
    }
    this.loadValues = null; // the loader may close over a parsed file — let it go
  }

  get(key) { this.ensureLoaded(); return super.get(key); }
  set(key, value) { this.ensureLoaded(); return super.set(key, value); }
  values() { this.ensureLoaded(); return super.values(); }
  entries() { this.ensureLoaded(); return super.entries(); }
  forEach(fn, thisArg) { this.ensureLoaded(); return super.forEach(fn, thisArg); }
  [Symbol.iterator]() { this.ensureLoaded(); return super[Symbol.iterator](); }
}

// True when `map` is a DiskBackedMap whose values haven't been read back yet.
function isUnloaded(map) {
  return map instanceof DiskBackedMap && !map.loaded;
}

module.exports = { DiskBackedMap, isUnloaded };
