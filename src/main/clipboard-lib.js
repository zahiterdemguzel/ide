// Pure (Electron-free) retry for the OS clipboard. On Windows the clipboard is a
// single lock that only one process may hold at a time, so a read/write can throw
// "OpenClipboard failed" while another app momentarily owns it. The lock clears
// within a few ms, so we retry a handful of times before giving up. Returning a
// fallback (instead of rethrowing) keeps the IPC call from rejecting — an
// unhandled rejection in the renderer's paste() silently dropped the paste, which
// is the intermittent "can't paste" bug. The Electron glue (the actual clipboard
// calls + the ipcMain handlers) lives in explorer.js; this stays here so the retry
// behavior is unit-testable.

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a synchronous clipboard op, retrying transient throws. Returns the op's
// result, or `fallback` (a value, or a function of the last error) if every
// attempt threw. `sleep` is injectable so tests don't wait on real timers.
async function withClipboardRetry(op, { attempts = 5, delayMs = 15, fallback, sleep = wait } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return op(); }
    catch (e) { lastErr = e; if (i < attempts - 1) await sleep(delayMs); }
  }
  return typeof fallback === 'function' ? fallback(lastErr) : fallback;
}

module.exports = { withClipboardRetry };
