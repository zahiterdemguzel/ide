// Pure concurrency limiter: `createLimiter(max)` returns a `limit(fn)` that runs
// each async `fn` with at most `max` in flight, queueing the rest FIFO. Keeps
// bursty, subprocess-heavy requests — the per-session diff stats, several git
// spawns each — from all launching at once on startup or a tab switch.
function createLimiter(max) {
  const queue = [];
  let active = 0;
  function pump() {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

// Coalesce bursts of "scan now" calls into shared runs: at most one `run` in
// flight, and every caller arriving while one is queued or running shares the
// NEXT run, which starts only after the current one settles. So every caller's
// result reflects state at-or-after the moment it asked (a snapshot from before
// its call would be stale), while an N-caller burst costs at most two runs.
function createCoalescer(run) {
  let inflight = null;
  let next = null;
  return () => {
    if (next) return next;
    next = Promise.resolve(inflight).catch(() => {}).then(() => {
      next = null;
      inflight = Promise.resolve().then(run).finally(() => { inflight = null; });
      return inflight;
    });
    return next;
  };
}

module.exports = { createLimiter, createCoalescer };
