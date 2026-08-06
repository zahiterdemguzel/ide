const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { shouldSkipDir } = require('./search-ignore');
const { QUERIES, langForPath, flattenCaptures, fromCaptures, extractGdscript } = require('./diagram-extract');
const { buildGraph, projectView } = require('./diagram-lib');
const { toElk, fromElk } = require('./diagram-elk');

// --- diagram panel (worker side) ---
// Parsing a whole project with tree-sitter and running an ELK layout over the
// result are both CPU-bound and both would stall PTY output and every other IPC
// if they ran on the main thread — so they run here, exactly like db-worker.js.
// diagram.js is the thin main-side proxy.
//
// State kept across calls, all keyed to one repo at a time:
//   parsers  loaded wasm grammars (loading one costs ~50ms, so never twice)
//   cache    per-file extraction keyed by path+mtime+size, so a refresh only
//            re-parses what actually changed on disk
//   graph    the last complete graph, so flipping a pass switch or changing view
//            re-projects and re-lays-out without re-reading a single file

const MAX_FILES = 4000;
const MAX_BYTES = 800 * 1024; // a single source file larger than this is generated, not written

let TS = null;
const parsers = new Map();   // lang -> { parser, query }
const cache = new Map();     // absPath -> { key, record }
let graph = null;            // last buildGraph() result
let graphRepo = null;

function wasmDir() {
  // Resolved from this file so it works in dev and inside an asar-packed build.
  return path.dirname(require.resolve('@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm'));
}

async function ensureParser(lang) {
  if (parsers.has(lang)) return parsers.get(lang);
  if (!TS) {
    TS = require('web-tree-sitter');
    await TS.Parser.init();
  }
  const language = await TS.Language.load(path.join(wasmDir(), `tree-sitter-${lang}.wasm`));
  const parser = new TS.Parser();
  parser.setLanguage(language);
  const entry = { parser, query: new TS.Query(language, QUERIES[lang]) };
  parsers.set(lang, entry);
  return entry;
}

// Every file in the repo we know how to read, with the stat we cache on.
async function listSources(repo) {
  const out = [];
  async function walk(rel) {
    if (out.length >= MAX_FILES) return;
    let ents;
    try { ents = await fs.promises.readdir(path.join(repo, rel), { withFileTypes: true }); }
    catch { return; }
    for (const d of ents) {
      if (d.isDirectory() && shouldSkipDir(d.name)) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { await walk(childRel); continue; }
      const lang = langForPath(d.name);
      if (!lang || out.length >= MAX_FILES) continue;
      let st;
      try { st = await fs.promises.stat(path.join(repo, childRel)); } catch { continue; }
      if (st.size > MAX_BYTES) continue;
      out.push({ rel, path: childRel, lang, key: `${st.mtimeMs}:${st.size}` });
    }
  }
  await walk('');
  return out;
}

async function extractFile(repo, file, warnings) {
  const abs = path.join(repo, file.path);
  let text;
  try { text = await fs.promises.readFile(abs, 'utf8'); }
  catch { return null; }

  if (file.lang === 'gdscript') return extractGdscript(file.path, text);

  const { parser, query } = await ensureParser(file.lang);
  let tree = null;
  try {
    tree = parser.parse(text);
    if (!tree) throw new Error('parser returned no tree');
    return fromCaptures(file.path, file.lang, flattenCaptures(query.matches(tree.rootNode)), text);
  } catch (e) {
    warnings.push(`${file.path}: ${e.message}`);
    return null;
  } finally {
    if (tree) tree.delete();
  }
}

// Parse (or reuse) every source file, then assemble the graph. `force` drops the
// per-file cache, which is what the panel's refresh button asks for.
async function build(repo, { force = false } = {}) {
  if (force || repo !== graphRepo) cache.clear();
  const files = await listSources(repo);
  const warnings = [];
  const records = [];
  const langWarned = new Set();

  for (const file of files) {
    const abs = path.join(repo, file.path);
    const hit = cache.get(abs);
    if (hit && hit.key === file.key) { if (hit.record) records.push(hit.record); continue; }
    let record = null;
    try {
      record = await extractFile(repo, file, warnings);
    } catch (e) {
      // A grammar that fails to load takes out its whole language, not the run.
      if (!langWarned.has(file.lang)) {
        langWarned.add(file.lang);
        warnings.push(`${file.lang}: grammar unavailable (${e.message})`);
      }
    }
    cache.set(abs, { key: file.key, record });
    if (record) records.push(record);
  }

  if (files.length >= MAX_FILES) warnings.push(`Stopped at ${MAX_FILES} files — the project is larger than the diagram indexes.`);

  graph = buildGraph(records, { warnings });
  graphRepo = repo;
  return graph;
}

const elk = (() => {
  let instance = null;
  return () => (instance ||= new (require('elkjs/lib/main.js'))());
})();

// Project the current graph to a view and lay it out. Never re-parses — that is
// what makes toggling a pass switch instant.
async function layout(opts) {
  if (!graph) return { ok: false, error: 'No project indexed yet' };
  const view = projectView(graph, opts);
  if (!view.nodes.length) {
    return { ok: true, diagram: { view: view.view, nodes: [], edges: [], width: 0, height: 0, meta: view.meta } };
  }
  const { graph: elkGraph, edgeMeta } = toElk(view);
  const laidOut = await elk().layout(elkGraph);
  return { ok: true, diagram: fromElk(laidOut, view, edgeMeta) };
}

const methods = {
  // Indexing and drawing are separate calls on purpose: `build` is the only one
  // that touches the disk, so the renderer can re-`layout` on every pass toggle
  // without paying for a re-parse.
  async build({ repo, force }) {
    const g = await build(repo, { force });
    return { ok: true, stats: g.stats, warnings: g.warnings };
  },
  async layout(opts) {
    return layout(opts);
  },
  reset() { cache.clear(); graph = null; graphRepo = null; return { ok: true }; },
};

parentPort.on('message', async ({ id, method, args }) => {
  let result;
  try {
    result = await methods[method](args);
  } catch (e) {
    result = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  parentPort.postMessage({ id, result });
});
