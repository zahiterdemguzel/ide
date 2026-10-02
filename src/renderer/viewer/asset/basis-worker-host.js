// Classic worker that hosts three.js's KTX2 (Basis) transcoder.
//
// The transcoder is an Emscripten/embind build that generates functions with
// `new Function(...)`. KTX2Loader normally runs it from a blob: worker, and a
// blob: worker inherits the page's CSP, which (rightly) has no 'unsafe-eval' —
// so it dies on startup. A worker loaded from a file URL gets its own (empty)
// policy instead, so this host receives the exact source KTX2Loader would have
// put in the blob and evaluates it here. See Ktx2FileWorkerLoader in model-scene.js.
self.onmessage = (event) => {
  if (!event.data || event.data.type !== 'boot') return;
  self.onmessage = null;
  // Indirect eval runs the source in global scope, as a worker script would;
  // it installs the transcoder's own onmessage handler for the 'init' that follows.
  (0, eval)(event.data.source);
};
