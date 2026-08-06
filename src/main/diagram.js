const path = require('path');
const { Worker } = require('worker_threads');
const bridge = require('./remote-bridge');
const { getRepoPath, onRepoChange } = require('./repo');
const { createCoalescer } = require('./concurrency');

// --- diagram panel (main side) ---
// Thin proxy over diagram-worker.js, which owns the tree-sitter grammars, the
// parse cache and the ELK layout. Same shape as db.js: the worker is spawned on
// the first call (a launch that never opens the panel pays nothing), requests
// are correlated by id, and a dead worker fails its in-flight calls instead of
// stranding the renderer.
//
// Two channels rather than one, because they cost very different amounts:
//   diagram-build   re-indexes the project (respecting the worker's mtime cache,
//                   or forcing a full re-parse). The only call that touches disk.
//   diagram-layout  projects the graph already in memory to one view and lays it
//                   out — what a pass switch or a view change needs, with no
//                   disk access at all.

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> resolve

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'diagram-worker.js'));
  worker.on('message', ({ id, result }) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  });
  // Indexing a huge repo can exhaust the worker's heap. Fail the awaits and drop
  // the worker so the next request starts clean rather than hanging the panel.
  const fail = (why) => {
    for (const resolve of pending.values()) resolve({ ok: false, error: `Diagram worker ${why}` });
    pending.clear();
    worker = null;
  };
  worker.on('error', (err) => { console.error('[diagram worker]', err); fail('crashed'); });
  worker.on('exit', (code) => { if (code !== 0) fail(`exited (${code})`); });
  return worker;
}

function call(method, args) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ensureWorker().postMessage({ id, method, args });
  });
}

// Opening the panel is itself a refresh, and the ⟳ button is another — so
// bursts are normal. Coalescing means an N-click burst costs at most two index
// passes while still guaranteeing every caller a result that reflects the disk
// at-or-after the moment it asked. A forced rebuild is tracked as a sticky flag
// rather than an argument, so a plain open that lands in the same burst as a ⟳
// still gets the fresh parse the ⟳ asked for.
let forceNext = false;
const coalescedBuild = createCoalescer(() => {
  const force = forceNext;
  forceNext = false;
  return call('build', { repo: getRepoPath(), force });
});

bridge.handle('diagram-build', (_e, opts) => {
  if (opts && opts.force) forceNext = true;
  return coalescedBuild();
});

bridge.handle('diagram-layout', (_e, opts) => call('layout', opts || {}));

// Switching projects invalidates every parse — the next open re-indexes.
onRepoChange(() => { if (worker) call('reset', {}); });

module.exports = {};
