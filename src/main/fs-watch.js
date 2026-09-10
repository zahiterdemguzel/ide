// A recursive watcher per tracked repo, whose ONLY job is to say "something
// changed in this tree just now" after a session's turn has already ended.
//
// Why: the tracker's two windows both close at a hook. A per-tool window closes
// at PostToolUse — but a command the agent BACKGROUNDS (a build, a dev server,
// `foo &`) keeps writing after its tool call returns. The turn window closes at
// Stop, and the next UserPromptSubmit re-baselines WITHOUT diffing, deliberately,
// so a change the user made by hand while the session sat idle isn't blamed on
// it. Between those two points is a hole: everything a backgrounded process wrote
// after Stop was absorbed into the next baseline and attributed to nobody. Agents
// that work through the shell background things constantly, so that hole is
// exactly where their work was going missing.
//
// The watcher does NOT attribute anything itself and is never a source of truth
// about what changed — it only wakes the existing turn-diff, which then reads the
// real state with the same `git status` snapshot and the same claim rules as
// every other path. If the watcher fails to start (an OS watch limit, a network
// share), tracking simply degrades to what it was before it existed.
//
// The tempting second use — skipping a `git status` scan when no event has
// arrived since the last one — is deliberately NOT done. Watch events are
// delivered asynchronously after the write completes, so "no event yet" does not
// mean "no change yet", and a Post hook that trusted it would silently drop the
// tool's changes.

const fs = require('fs');
const path = require('path');
const { isNoiseEvent } = require('./fs-watch-lib');

// How long the tree must go quiet before we wake the tracker. Long enough that a
// build writing hundreds of files settles into one diff rather than hundreds, and
// that we aren't racing the writer to read a half-written file.
const QUIET_MS = 1500;

// A watcher is shared by every session on the same tree and ref-counted, since
// sessions on one project are the normal case.
const watchers = new Map(); // resolved repo path -> { watcher, refs, timer, onSettle }

function settle(entry, repo) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    try { entry.onSettle(repo); } catch { /* a settle diff must never take the app down */ }
  }, QUIET_MS);
}

// Start (or join) the watcher for `repo`. `onSettle(repo)` is called once the
// tree has been quiet for QUIET_MS after a non-noise change. Returns a release
// function; the watcher closes when the last holder releases it.
function watchRepo(repo, onSettle) {
  const key = path.resolve(repo);
  let entry = watchers.get(key);
  if (!entry) {
    entry = { watcher: null, refs: 0, timer: null, onSettle };
    try {
      // Recursive watching is native on Windows and macOS and supported on Linux
      // from Node 20.13; anything older (or an OS watch limit) throws here and we
      // run without a watcher rather than walking the tree ourselves.
      entry.watcher = fs.watch(key, { recursive: true, persistent: false }, (_ev, name) => {
        if (name && isNoiseEvent(String(name))) return;
        settle(entry, key);
      });
      entry.watcher.on('error', () => { /* the tree went away; the diff path still works */ });
    } catch {
      entry.watcher = null;
    }
    watchers.set(key, entry);
  }
  entry.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs--;
    if (entry.refs > 0) return;
    clearTimeout(entry.timer);
    try { entry.watcher && entry.watcher.close(); } catch { /* already closed */ }
    watchers.delete(key);
  };
}

// Whether `repo` is being watched — false when the OS refused, which the tracker
// notes but does not act on.
function isWatching(repo) {
  const e = watchers.get(path.resolve(repo));
  return Boolean(e && e.watcher);
}

function stopAll() {
  for (const [, e] of watchers) {
    clearTimeout(e.timer);
    try { e.watcher && e.watcher.close(); } catch { /* already closed */ }
  }
  watchers.clear();
}

module.exports = { watchRepo, isWatching, stopAll, QUIET_MS };
