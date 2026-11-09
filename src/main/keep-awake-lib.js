// Holds the machine awake while any "reason" is active (a working agent, a running
// command). `startBlocker`/`stopBlocker` are injected so the logic is testable
// without Electron: startBlocker() returns an id, stopBlocker(id) releases it.
function createKeepAwake({ startBlocker, stopBlocker }) {
  const activeReasons = new Set();
  let blockerId = null;

  function acquire() {
    if (blockerId !== null) return;
    try { blockerId = startBlocker(); } catch (err) { console.error('[keep-awake]', err); blockerId = null; }
  }
  function release() {
    if (blockerId === null) return;
    try { stopBlocker(blockerId); } catch (err) { console.error('[keep-awake]', err); }
    blockerId = null;
  }

  // Idempotent per reason: safe to call on every state change.
  function setReason(reason, isActive) {
    if (isActive) activeReasons.add(reason); else activeReasons.delete(reason);
    if (activeReasons.size > 0) acquire(); else release();
  }

  return { setReason, isHolding: () => blockerId !== null };
}

module.exports = { createKeepAwake };
