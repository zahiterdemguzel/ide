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

module.exports = { createLimiter };
