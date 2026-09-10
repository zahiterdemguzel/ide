// Pure (Electron-free) helpers for the repo watcher in fs-watch.js — which
// paths it may ignore outright, and which idle session a settle-diff belongs to.
// Unit-tested in test/fs-watch-lib.test.js.

const path = require('path');
const { shouldSkipDir } = require('./search-ignore');

// Paths the watcher never wakes anyone for. `.git` is the loud one: every git
// command this app runs (and there are many — a status scan per tool call)
// rewrites index/refs/logs inside it, so an unfiltered watcher would fire
// continuously on the tracker's own activity. The rest are the dependency and
// build directories the explorer's search already prunes; a `npm install` or a
// build writing tens of thousands of files there is not session work anyone
// wants attributed, and waking for each would be a live-lock.
function isNoiseEvent(rel) {
  if (!rel) return true;
  const parts = rel.split(/[\\/]/);
  // The last segment is the file itself; only DIRECTORY segments are judged, so
  // a source file that merely shares a name with a build dir still counts.
  return parts.slice(0, -1).some(shouldSkipDir);
}

// The session a post-turn filesystem change should be attributed to: among the
// sessions on `repo` that are settled (not mid-turn) and still hold a turn
// baseline, the one whose turn ended most recently. That's the session that
// backgrounded the process still writing — a build, a dev server, a `&`-ed
// command — which is the only case this watcher exists for.
//
// Deliberately ONE session, never all of them: attribution here is a guess, and
// the wider tracker's rule is that an unattributable change belongs to nobody.
// Handing the same change to every idle session would put one file in several
// sessions' commits. A tie (two turns ending in the same millisecond) picks
// neither, for the same reason.
function settleTarget(entries) {
  let best = null, tie = false;
  for (const e of entries) {
    if (!e || e.repo == null || e.working || !e.hasBaseline) continue;
    if (!best || e.turnEndedAt > best.turnEndedAt) { best = e; tie = false; }
    else if (e.turnEndedAt === best.turnEndedAt) tie = true;
  }
  return tie ? null : best;
}

// Same tree? Compared as resolved paths so a worktree session's tree is never
// confused with the project it was cut from.
function sameTree(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

module.exports = { isNoiseEvent, settleTarget, sameTree };
