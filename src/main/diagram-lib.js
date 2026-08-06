// --- diagram: code graph assembly (pure) ---
// Turns the per-file extraction records produced by diagram-extract.js into one
// language-agnostic graph, then projects that graph down to what a given
// diagram view + pass switches actually want to draw. No fs, no electron, no
// tree-sitter — everything here is data in, data out, so it is unit-testable.
//
// Two stages, deliberately separate:
//   buildGraph()   file records -> the complete graph (every folder, module,
//                  type, member, and every edge we could resolve). Expensive,
//                  done once per parse.
//   projectView()  complete graph -> the subset one view draws, with the passes
//                  the user left switched on. Cheap, re-run on every toggle so
//                  flipping a switch never re-parses the project.

const VIEWS = ['overview', 'classes', 'deps', 'calls', 'inheritance'];

// Pass switches, in toolbar order. `edges` names the edge kinds a pass governs;
// the rest govern which nodes survive or how edges are pruned.
const PASSES = [
  { id: 'inheritance', edges: ['extends', 'implements'] },
  { id: 'imports', edges: ['imports'] },
  { id: 'calls', edges: ['calls'] },
  { id: 'instantiation', edges: ['instantiates'] },
  { id: 'members', edges: [] },
  { id: 'simplify', edges: [] },
  { id: 'externals', edges: [] },
  { id: 'orphans', edges: [] },
];

const DEFAULT_PASSES = {
  inheritance: true, imports: true, calls: true, instantiation: true,
  members: true, simplify: true, externals: false, orphans: false,
};

// What each view is made of.
//   kinds      the node kinds it draws
//   edges      the edge kinds it can draw (subject to the pass switches)
//   aggregate  collapse everything below the focus into one box per immediate
//              child, so the view always shows ONE level rather than the whole
//              subtree — this is what keeps the overview readable
//   reduce     eligible for transitive reduction (dependency-shaped views only)
const VIEW_SPEC = {
  overview: { kinds: ['module'], edges: ['imports'], aggregate: true, reduce: true },
  classes: { kinds: ['class', 'interface', 'enum', 'struct', 'method', 'field'], edges: ['extends', 'implements', 'instantiates', 'calls'] },
  deps: { kinds: ['module'], edges: ['imports'], reduce: true },
  calls: { kinds: ['function', 'method'], edges: ['calls'] },
  inheritance: { kinds: ['class', 'interface', 'enum', 'struct'], edges: ['extends', 'implements'] },
};

const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'struct']);
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor']);
const METHOD_KINDS = new Set(['method', 'constructor']);

// How many boxes a view draws before it starts capping.
//
// These are deliberately small. A diagram stops being *readable* long before it
// stops being drawable: 400 boxes and 700 edges lay out fine and tell you
// nothing. The number of things a person can hold in their head at once is the
// real constraint, so the views aim for a couple of dozen boxes and rely on
// drilling in for depth — the same way a map shows countries before streets.
const READABLE_MAX = 30;
const VIEW_MAX_NODES = { overview: 30, classes: 30, deps: 35, calls: 30, inheritance: 50 };

// --- ids -------------------------------------------------------------------
// Repo-relative paths always use '/', so plain string math beats path.* here
// (and keeps this module free of node builtins).

const folderId = (dir) => `d:${dir}`;
const moduleId = (file) => `m:${file}`;
const symbolId = (file, qual) => `s:${file}#${qual}`;
const externalId = (name) => `x:${name}`;
const packageId = (name) => `p:${name}`;

function dirOf(file) {
  const i = file.lastIndexOf('/');
  return i < 0 ? '' : file.slice(0, i);
}

function baseOf(file) {
  const i = file.lastIndexOf('/');
  return i < 0 ? file : file.slice(i + 1);
}

// The last segment of a dotted/qualified name — what a cross-file reference is
// almost always written as at the use site.
function simpleName(qual) {
  const i = qual.lastIndexOf('.');
  return i < 0 ? qual : qual.slice(i + 1);
}

// --- stage 1: build --------------------------------------------------------

// `files` is the extractor output: [{ path, lang, symbols, imports, calls, news }].
// See diagram-extract.js for the record shape. Returns the complete graph plus
// the warnings the extractors raised (unsupported language, parse failure, ...).
function buildGraph(files, { warnings = [] } = {}) {
  const nodes = new Map(); // id -> node
  const edges = [];
  const add = (node) => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
  const link = (from, to, kind, meta) => { if (from && to && from !== to) edges.push({ from, to, kind, ...meta }); };

  // Folder chain, so the overview view can nest modules inside compound boxes.
  function ensureFolders(dir) {
    if (!dir) return null;
    const parts = dir.split('/');
    let parent = null;
    let acc = '';
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part;
      const id = folderId(acc);
      add({ id, kind: 'folder', name: part, file: acc, parent });
      parent = id;
    }
    return parent;
  }

  // --- nodes: modules, folders, symbols
  const byFile = new Map(); // file -> { moduleId, symbols: Map<qual, id> }
  for (const rec of files) {
    const mid = moduleId(rec.path);
    add({ id: mid, kind: 'module', name: baseOf(rec.path), file: rec.path, line: 1, lang: rec.lang, parent: ensureFolders(dirOf(rec.path)) });
    const symbols = new Map();
    byFile.set(rec.path, { moduleId: mid, symbols });

    for (const sym of rec.symbols) {
      const qual = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
      const id = symbolId(rec.path, qual);
      symbols.set(qual, id);
      add({
        id, kind: sym.kind, name: sym.name, qual,
        file: rec.path, line: sym.line, endLine: sym.endLine, lang: rec.lang,
        signature: sym.signature, visibility: sym.visibility, static: sym.static,
        parent: sym.parent ? symbolId(rec.path, sym.parent) : mid,
      });
    }
  }

  // A symbol's declared parent may itself be missing (a method whose enclosing
  // class the grammar didn't surface). Reparent those onto the module so no node
  // dangles outside the containment tree.
  for (const node of nodes.values()) {
    if (node.parent && !nodes.has(node.parent)) node.parent = byFile.get(node.file)?.moduleId ?? null;
    if (node.parent) link(node.parent, node.id, 'contains');
  }

  // --- resolution index: simple name -> candidate node ids
  const byName = new Map();
  for (const node of nodes.values()) {
    if (node.kind === 'folder' || node.kind === 'module') continue;
    const key = node.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(node.id);
  }

  // Resolve a name written inside `file` to a definition, in order of how much
  // the evidence is worth: the same file, then a file this one actually imports,
  // then a globally unique match, then the same folder. Anything still ambiguous
  // resolves to nothing — a missing edge is much cheaper than a wrong one.
  function resolve(name, file, want, visible) {
    const cands = (byName.get(simpleName(name)) || []).filter((id) => !want || want.has(nodes.get(id).kind));
    if (!cands.length) return null;
    const only = (list) => (list.length === 1 ? list[0] : null);
    const here = cands.filter((id) => nodes.get(id).file === file);
    if (here.length) return only(here);
    if (visible && visible.size) {
      const imported = cands.filter((id) => visible.has(nodes.get(id).file));
      if (imported.length) return only(imported);
    }
    if (cands.length === 1) return cands[0];
    return only(cands.filter((id) => dirOf(nodes.get(id).file) === dirOf(file)));
  }

  // --- edges: imports (first, because what a file imports is the evidence the
  // call and inheritance resolution below leans on)
  const visibleFiles = new Map(); // file -> Set of files it imports
  for (const rec of files) {
    const from = moduleId(rec.path);
    const visible = new Set();
    visibleFiles.set(rec.path, visible);
    for (const imp of rec.imports || []) {
      const target = resolveImport(imp.target, rec.path, byFile);
      if (target) { link(from, target, 'imports'); visible.add(nodes.get(target).file); }
      else if (imp.package) link(from, add({ id: packageId(imp.package), kind: 'package', name: imp.package }).id, 'imports', { external: true });
    }
  }

  // --- edges: inheritance
  for (const rec of files) {
    for (const sym of rec.symbols) {
      const qual = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
      const from = symbolId(rec.path, qual);
      for (const [kind, names] of [['extends', sym.extends], ['implements', sym.implements]]) {
        for (const name of names || []) {
          const target = resolve(name, rec.path, TYPE_KINDS, visibleFiles.get(rec.path));
          if (target) link(from, target, kind);
          else link(from, add({ id: externalId(simpleName(name)), kind: 'external', name: simpleName(name) }).id, kind, { external: true });
        }
      }
    }
  }

  // --- edges: calls and instantiations
  for (const rec of files) {
    const visible = visibleFiles.get(rec.path);
    for (const [list, kind, want] of [[rec.calls, 'calls', CALLABLE_KINDS], [rec.news, 'instantiates', TYPE_KINDS]]) {
      for (const use of list || []) {
        const from = use.from ? symbolId(rec.path, use.from) : moduleId(rec.path);
        if (!nodes.has(from)) continue;
        // `x.foo()` can only be a method. Without this, every `s.trim()` in the
        // project would hang an edge on a top-level helper named trim().
        const target = resolve(use.name, rec.path, use.method ? METHOD_KINDS : want, visible);
        if (target) link(from, target, kind, { line: use.line });
        else if (kind === 'instantiates') {
          link(from, add({ id: externalId(use.name), kind: 'external', name: use.name }).id, kind, { external: true });
        }
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: dedupeEdges(edges),
    warnings,
    stats: countKinds(files, nodes),
  };
}

// A relative import specifier -> the module node it names. Extensionless and
// directory-index forms both have to be tried, since every language in scope
// writes at least one of them.
const IMPORT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.gd', '/index.js', '/index.ts', '/__init__.py'];

function resolveImport(spec, fromFile, byFile) {
  if (!spec) return null;
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) base = joinRel(dirOf(fromFile), spec);
  else if (spec.startsWith('res://')) base = spec.slice('res://'.length); // Godot project-root paths
  else if (spec.startsWith('/')) base = spec.slice(1);
  else return null; // bare specifier: a package, not a file in this repo
  for (const suffix of IMPORT_SUFFIXES) {
    const cand = base + suffix;
    if (byFile.has(cand)) return byFile.get(cand).moduleId;
  }
  return null;
}

// Resolve `./a/../b` against a directory, on repo-relative '/' paths only.
function joinRel(dir, spec) {
  const out = dir ? dir.split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// Collapse parallel edges of the same kind into one carrying a `count`, so a
// method calling another fifty times draws one line, not fifty.
function dedupeEdges(edges) {
  const seen = new Map();
  for (const e of edges) {
    const key = `${e.kind} ${e.from} ${e.to}`;
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { ...e, count: 1 });
  }
  return [...seen.values()];
}

function countKinds(files, nodes) {
  const kinds = {};
  for (const n of nodes.values()) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  const langs = {};
  for (const f of files) langs[f.lang] = (langs[f.lang] || 0) + 1;
  return { files: files.length, kinds, langs };
}

// --- stage 2: project ------------------------------------------------------

// Reduce the full graph to what one view should actually draw.
//
// The ordering below is the whole design, and it is about legibility rather
// than completeness:
//   1. focus      restrict to a subtree — drilling in is how depth is reached
//   2. aggregate  collapse the subtree to ONE level, so the overview of a
//                 400-file project is ~12 boxes, not 400
//   3. lift       re-hang edges of anything hidden onto what survived, so the
//                 relationships are still true at the level being shown
//   4. reduce     drop dependency edges that a longer path already implies —
//                 this is what turns a dependency hairball into a shape
//   5. cap        keep the best-connected, and say so
//
// Returns { nodes, edges, meta }; `meta` reports capping and cycles so the UI
// can tell the user what it left out instead of silently lying.
function projectView(graph, opts = {}) {
  const view = VIEWS.includes(opts.view) ? opts.view : 'overview';
  const passes = { ...DEFAULT_PASSES, ...(opts.passes || {}) };
  const maxNodes = opts.maxNodes || VIEW_MAX_NODES[view] || READABLE_MAX;
  const spec = VIEW_SPEC[view];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const focus = opts.focus || '';

  const wantKinds = new Set(spec.kinds);
  if (!passes.members) { wantKinds.delete('method'); wantKinds.delete('field'); }

  const wantEdges = new Set(spec.edges.filter((kind) => {
    const pass = PASSES.find((p) => p.edges.includes(kind));
    return !pass || passes[pass.id];
  }));

  const inFocus = focusFilter(focus, byId);
  const candidates = graph.nodes.filter((n) => wantKinds.has(n.kind) && inFocus(n) && !strayMember(n, view, byId));

  // Step 2. In an aggregating view every candidate is represented by its
  // ancestor one level below the focus, so a folder of 90 files is one box
  // labelled with what it holds. `absorbed` is what that box stands for, and is
  // shown on it — a box that silently represents 90 files would be a lie.
  const absorbed = new Map();
  const keepIds = new Set();
  for (const n of candidates) {
    const id = spec.aggregate ? aggregateId(n, focus) : n.id;
    if (!byId.has(id)) continue;
    keepIds.add(id);
    absorbed.set(id, (absorbed.get(id) || 0) + 1);
  }
  if (passes.externals) {
    for (const n of graph.nodes) {
      if ((n.kind === 'external' || n.kind === 'package') && externalWanted(n, wantEdges)) keepIds.add(n.id);
    }
  }

  // Members drawn as rows inside their class box are not boxes of their own.
  // Splitting them out here matters for more than rendering: every measurement
  // below (degree, orphan, cap) has to be taken on the boxes that will actually
  // be drawn, so a class whose only relationships come from its methods counts
  // as connected rather than as an orphan.
  const wanted = [...keepIds];
  const inlined = wanted.filter((id) => isInlinedMember(byId.get(id), view, byId));
  let boxes = wanted.filter((id) => !isInlinedMember(byId.get(id), view, byId));

  const relevant = graph.edges.filter((e) => wantEdges.has(e.kind));
  const simplify = (edges) => (passes.simplify && spec.reduce ? transitiveReduction(edges) : edges);
  const degree = degreeOf(simplify(liftEdges(relevant, new Set(boxes), byId)));

  // An aggregate box stands for a whole folder, and a folder with no
  // cross-folder dependency is still one of the project's parts — culling it
  // would answer "what is this project made of?" by leaving pieces out. Orphan
  // hiding is for detail views, where a lone unconnected class really is noise.
  if (!passes.orphans && !spec.aggregate) boxes = boxes.filter((id) => degree.get(id));

  const total = boxes.length;
  let truncated = false;
  if (boxes.length > maxNodes) {
    // Keep the best-connected nodes: they are the ones that explain the shape of
    // the project. Ties broken by id so the result is stable across refreshes.
    boxes.sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || String(a).localeCompare(String(b)));
    boxes = boxes.slice(0, maxNodes);
    truncated = true;
  }

  const drawIds = new Set(boxes);
  // Member rows come back only for a class box that survived.
  const rowIds = new Set(inlined.filter((id) => drawIds.has(byId.get(id).parent)));

  const outNodes = [...drawIds].map((id) => {
    const node = viewNode(byId.get(id), view, rowIds, byId);
    // Only an aggregate box stands for more than itself.
    if (spec.aggregate && absorbed.get(id) > 1) node.absorbed = absorbed.get(id);
    return node;
  });

  const lifted = liftEdges(relevant, drawIds, byId);
  const outEdges = markCycles(simplify(lifted));

  return {
    view,
    nodes: outNodes,
    edges: outEdges,
    meta: {
      shown: outNodes.length, total, truncated,
      aggregated: !!spec.aggregate,
      hiddenEdges: lifted.length - outEdges.length,
      cycles: outEdges.filter((e) => e.cyclic).length,
      warnings: graph.warnings || [],
      stats: graph.stats || {},
    },
  };
}

// The id of the box that represents `node` at one level below `focus`: either a
// file sitting directly in the focus folder, or the subfolder that contains it.
function aggregateId(node, focus) {
  const file = node.file || '';
  const rel = focus ? file.slice(focus.length + 1) : file;
  const i = rel.indexOf('/');
  if (i < 0) return moduleId(file);
  return folderId(focus ? `${focus}/${rel.slice(0, i)}` : rel.slice(0, i));
}

// Drop every edge that a longer path already implies: if A→B→C exists, the
// direct A→C says nothing new and is pure ink. On a real dependency graph this
// is the single biggest difference between a shape and a hairball.
//
// Applied per edge kind, and never to an edge with no alternative route — so
// genuine cycles survive intact rather than being silently broken.
function transitiveReduction(edges) {
  const kinds = new Map();
  for (const e of edges) {
    if (!kinds.has(e.kind)) kinds.set(e.kind, []);
    kinds.get(e.kind).push(e);
  }
  const out = [];
  for (const [, group] of kinds) {
    const adj = adjacency(group);
    for (const e of group) {
      out.push(reachableWithout(adj, e.from, e.to, e) ? { ...e, implied: true } : e);
    }
  }
  return out.filter((e) => !e.implied);
}

// Mark the edges that take part in a dependency cycle. A cycle is the one thing
// in a dependency graph that is always worth pointing at, so it gets its own
// styling rather than being left for the reader to trace.
function markCycles(edges) {
  const kinds = new Map();
  for (const e of edges) {
    if (!kinds.has(e.kind)) kinds.set(e.kind, []);
    kinds.get(e.kind).push(e);
  }
  const out = [];
  for (const [, group] of kinds) {
    const adj = adjacency(group);
    for (const e of group) out.push(reachable(adj, e.to, e.from) ? { ...e, cyclic: true } : e);
  }
  return out;
}

function adjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e);
  }
  return adj;
}

function reachable(adj, from, to) {
  return reachableWithout(adj, from, to, null);
}

// Breadth-first search from `from` to `to`, ignoring `skip` — the edge whose
// redundancy is being tested. Without the skip an edge would always "prove"
// itself.
function reachableWithout(adj, from, to, skip) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    for (const edge of adj.get(queue.shift()) || []) {
      if (edge === skip) continue;
      if (edge.to === to) return true;
      if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
    }
  }
  return false;
}

// The node as the view wants it. Members are attached to their owning type as
// rows rather than as separate boxes (a UML class box, not a scatter of tiny
// nodes); `rowIds` is the set of member nodes eligible to be drawn as rows.
function viewNode(node, view, rowIds, byId) {
  const out = {
    id: node.id, kind: node.kind, name: node.name, file: node.file,
    line: node.line, lang: node.lang, signature: node.signature,
    visibility: node.visibility, static: node.static,
  };
  if (view === 'classes' && TYPE_KINDS.has(node.kind)) {
    out.members = [...rowIds]
      .map((id) => byId.get(id))
      .filter((m) => m.parent === node.id && (m.kind === 'method' || m.kind === 'field'))
      .sort((a, b) => (a.kind === b.kind ? a.line - b.line : a.kind === 'field' ? -1 : 1))
      .map((m) => ({ id: m.id, kind: m.kind, name: m.name, line: m.line, signature: m.signature, visibility: m.visibility, static: m.static }));
  }
  return out;
}

// A class diagram should contain classes. Plenty of languages produce
// method-shaped nodes that belong to no type at all (an object literal's
// shorthand methods, a module-level function) — those are not class members and
// drawing them as loose boxes is exactly the noise that makes a generated class
// diagram unreadable.
function strayMember(node, view, byId) {
  if (view !== 'classes') return false;
  if (node.kind !== 'method' && node.kind !== 'field') return false;
  const parent = node.parent && byId.get(node.parent);
  return !parent || !TYPE_KINDS.has(parent.kind);
}

// In the class view a member is drawn inside its type, so it must not also be a
// standalone node. Everything else keeps its own box.
function isInlinedMember(node, view, byId) {
  if (view !== 'classes') return false;
  if (node.kind !== 'method' && node.kind !== 'field') return false;
  const parent = node.parent && byId.get(node.parent);
  return !!parent && TYPE_KINDS.has(parent.kind);
}

function externalWanted(node, wantEdges) {
  if (node.kind === 'package') return wantEdges.has('imports');
  return wantEdges.has('extends') || wantEdges.has('implements') || wantEdges.has('instantiates');
}

// Restrict to a folder or file subtree. An empty focus keeps everything.
function focusFilter(focus, byId) {
  if (!focus) return () => true;
  const prefix = focus.endsWith('/') ? focus : focus + '/';
  return (node) => {
    if (node.kind === 'external' || node.kind === 'package') return true;
    const file = node.file || byId.get(node.parent)?.file || '';
    return file === focus || file.startsWith(prefix);
  };
}

// Remap every edge onto the nearest surviving ancestor of each endpoint, so
// hiding members (or drilling into a folder) turns "A.foo() calls B.bar()" into
// "A calls B" rather than dropping the relationship. Self-edges and duplicates
// collapse away.
function liftEdges(edges, keepIds, byId) {
  const lift = (id) => {
    let cur = byId.get(id);
    while (cur && !keepIds.has(cur.id)) cur = cur.parent ? byId.get(cur.parent) : null;
    return cur ? cur.id : null;
  };
  const out = [];
  for (const e of edges) {
    const from = lift(e.from);
    const to = lift(e.to);
    if (!from || !to || from === to) continue;
    out.push({ ...e, from, to, lifted: from !== e.from || to !== e.to });
  }
  return dedupeEdges(out);
}

function degreeOf(edges) {
  const d = new Map();
  for (const e of edges) {
    d.set(e.from, (d.get(e.from) || 0) + 1);
    d.set(e.to, (d.get(e.to) || 0) + 1);
  }
  return d;
}

// Case-insensitive substring match used by the panel's search box. Returns the
// ids to highlight; the renderer dims the rest rather than removing them, so the
// surrounding structure stays visible.
function searchNodes(nodes, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return new Set();
  const hits = new Set();
  for (const n of nodes) {
    if (n.name.toLowerCase().includes(q) || (n.file || '').toLowerCase().includes(q)) hits.add(n.id);
    else if ((n.members || []).some((m) => m.name.toLowerCase().includes(q))) hits.add(n.id);
  }
  return hits;
}

module.exports = {
  VIEWS, PASSES, DEFAULT_PASSES, VIEW_SPEC,
  TYPE_KINDS, CALLABLE_KINDS, METHOD_KINDS, READABLE_MAX, VIEW_MAX_NODES,
  folderId, moduleId, symbolId, externalId, packageId,
  dirOf, baseOf, simpleName, joinRel,
  buildGraph, projectView, liftEdges, dedupeEdges, searchNodes, isInlinedMember, strayMember,
  aggregateId, transitiveReduction, markCycles,
};
