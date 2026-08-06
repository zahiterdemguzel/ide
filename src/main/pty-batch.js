// Electron-free PTY output coalescer. A live terminal (Claude's Ink TUI
// especially) emits tens of tiny chunks per second; shipping each as its own IPC
// message — structured-cloned, broadcast to remote listeners, VT-parsed by the
// renderer — is what made the app lag with many sessions producing output at
// once. `createPtyBatcher(flush)` buffers each id's chunks and calls
// `flush(id, concatenated)` once per frame (~16 ms), preserving order within an
// id. `flushId(id)` drains an id's tail immediately (call it on PTY exit so the
// final output isn't lost behind a pending timer). Timer functions are
// injectable so tests drive the batching with a manual scheduler.
function createPtyBatcher(flush, { intervalMs = 16, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map(); // id -> { data, timer }

  function fire(id) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimer(p.timer);
    if (p.data) flush(id, p.data);
  }

  function push(id, data) {
    const p = pending.get(id);
    if (p) { p.data += data; return; }
    pending.set(id, { data, timer: setTimer(() => fire(id), intervalMs) });
  }

  return { push, flushId: fire };
}

module.exports = { createPtyBatcher };
