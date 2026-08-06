const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGraph, projectView, liftEdges, dedupeEdges, searchNodes, joinRel, simpleName,
  transitiveReduction, markCycles,
  moduleId, symbolId, folderId, externalId, packageId,
} = require('../src/main/diagram-lib');

// Terse builders for extractor records — the tests are about the graph, not
// about restating the record shape a dozen times.
const sym = (name, over = {}) => ({
  kind: 'class', name, parent: '', line: 1, endLine: 2, extends: [], implements: [], ...over,
});
const file = (path, over = {}) => ({ path, lang: 'javascript', symbols: [], imports: [], calls: [], news: [], ...over });

const edgeSet = (graph, kind) => graph.edges
  .filter((e) => e.kind === kind)
  .map((e) => `${e.from} -> ${e.to}`)
  .sort();

// --- containment -----------------------------------------------------------

test('buildGraph: folders, modules and symbols form one containment tree', () => {
  const g = buildGraph([file('src/app/main.js', { symbols: [sym('App'), sym('run', { kind: 'method', parent: 'App' })] })]);
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(ids.has(folderId('src')));
  assert.ok(ids.has(folderId('src/app')));
  assert.ok(ids.has(moduleId('src/app/main.js')));

  const app = g.nodes.find((n) => n.name === 'App');
  const run = g.nodes.find((n) => n.name === 'run');
  assert.equal(app.parent, moduleId('src/app/main.js'));
  assert.equal(run.parent, app.id);
  assert.equal(run.id, symbolId('src/app/main.js', 'App.run'));
  // The folder chain nests rather than sitting flat under the root.
  assert.equal(g.nodes.find((n) => n.id === folderId('src/app')).parent, folderId('src'));
});

test('buildGraph: a member whose declared parent is missing reparents onto its module', () => {
  const g = buildGraph([file('a.js', { symbols: [sym('orphan', { kind: 'method', parent: 'Ghost' })] })]);
  assert.equal(g.nodes.find((n) => n.name === 'orphan').parent, moduleId('a.js'));
});

// --- inheritance -----------------------------------------------------------

test('buildGraph: extends and implements resolve to the defining class', () => {
  const g = buildGraph([
    file('base.js', { symbols: [sym('Animal')] }),
    file('dog.js', {
      symbols: [sym('Dog', { extends: ['Animal'], implements: ['Greeter'] })],
      imports: [{ target: './base.js', package: null }],
    }),
    file('greeter.js', { symbols: [sym('Greeter', { kind: 'interface' })] }),
  ]);
  assert.deepEqual(edgeSet(g, 'extends'), [`${symbolId('dog.js', 'Dog')} -> ${symbolId('base.js', 'Animal')}`]);
  assert.deepEqual(edgeSet(g, 'implements'), [`${symbolId('dog.js', 'Dog')} -> ${symbolId('greeter.js', 'Greeter')}`]);
});

test('buildGraph: an unknown supertype becomes an external node, not a dropped edge', () => {
  const g = buildGraph([file('a.js', { symbols: [sym('Widget', { extends: ['React.Component'] })] })]);
  const ext = g.nodes.find((n) => n.kind === 'external');
  assert.equal(ext.name, 'Component');
  assert.equal(g.edges.find((e) => e.kind === 'extends').to, externalId('Component'));
});

// --- imports ---------------------------------------------------------------

test('buildGraph: relative imports resolve across extension and index forms', () => {
  const g = buildGraph([
    file('src/a.js', {
      imports: [
        { target: './b', package: null },
        { target: '../lib/util.js', package: null },
        { target: './deep', package: null },
      ],
    }),
    file('src/b.js'),
    file('lib/util.js'),
    file('src/deep/index.js'),
  ]);
  assert.deepEqual(edgeSet(g, 'imports'), [
    `${moduleId('src/a.js')} -> ${moduleId('lib/util.js')}`,
    `${moduleId('src/a.js')} -> ${moduleId('src/b.js')}`,
    `${moduleId('src/a.js')} -> ${moduleId('src/deep/index.js')}`,
  ]);
});

test('buildGraph: a bare specifier becomes one package node per package', () => {
  const g = buildGraph([
    file('a.js', { imports: [{ target: 'lodash/fp', package: 'lodash' }, { target: 'lodash', package: 'lodash' }] }),
  ]);
  assert.equal(g.nodes.filter((n) => n.kind === 'package').length, 1);
  const edge = g.edges.find((e) => e.to === packageId('lodash'));
  assert.equal(edge.count, 2, 'the two imports collapse to one edge');
});

test('buildGraph: Godot res:// imports resolve from the project root', () => {
  const g = buildGraph([
    file('src/player.gd', { lang: 'gdscript', imports: [{ target: 'res://src/bullet.gd', package: null }] }),
    file('src/bullet.gd', { lang: 'gdscript' }),
  ]);
  assert.deepEqual(edgeSet(g, 'imports'), [`${moduleId('src/player.gd')} -> ${moduleId('src/bullet.gd')}`]);
});

// --- calls -----------------------------------------------------------------

test('buildGraph: a call is attributed to the calling symbol, not the file', () => {
  const g = buildGraph([file('a.js', {
    symbols: [sym('run', { kind: 'function' }), sym('helper', { kind: 'function' })],
    calls: [{ from: 'run', name: 'helper', line: 3 }],
  })]);
  assert.deepEqual(edgeSet(g, 'calls'), [`${symbolId('a.js', 'run')} -> ${symbolId('a.js', 'helper')}`]);
});

test('buildGraph: a receiver call never resolves to a same-named free function', () => {
  const records = [file('a.js', {
    symbols: [sym('run', { kind: 'function' }), sym('trim', { kind: 'function' })],
    calls: [{ from: 'run', name: 'trim', line: 3, method: true }],
  })];
  assert.deepEqual(edgeSet(buildGraph(records), 'calls'), [], 's.trim() must not hit function trim()');

  // The same call does resolve when a real method by that name exists.
  records[0].symbols.push(sym('Str'), sym('trim', { kind: 'method', parent: 'Str' }));
  assert.equal(buildGraph(records).edges.some((e) => e.kind === 'calls' && e.to === symbolId('a.js', 'Str.trim')), true);
});

test('buildGraph: an ambiguous name resolves to nothing rather than to a guess', () => {
  const g = buildGraph([
    file('a.js', { symbols: [sym('go', { kind: 'function' })] }),
    file('b.js', { symbols: [sym('go', { kind: 'function' })] }),
    file('c.js', { symbols: [sym('caller', { kind: 'function' })], calls: [{ from: 'caller', name: 'go', line: 1 }] }),
  ]);
  assert.deepEqual(edgeSet(g, 'calls'), []);
});

test('buildGraph: an import disambiguates a name defined in two places', () => {
  const g = buildGraph([
    file('a.js', { symbols: [sym('go', { kind: 'function' })] }),
    file('b.js', { symbols: [sym('go', { kind: 'function' })] }),
    file('c.js', {
      symbols: [sym('caller', { kind: 'function' })],
      imports: [{ target: './b.js', package: null }],
      calls: [{ from: 'caller', name: 'go', line: 1 }],
    }),
  ]);
  assert.deepEqual(edgeSet(g, 'calls'), [`${symbolId('c.js', 'caller')} -> ${symbolId('b.js', 'go')}`]);
});

test('buildGraph: a local definition beats an imported one of the same name', () => {
  const g = buildGraph([
    file('lib.js', { symbols: [sym('go', { kind: 'function' })] }),
    file('c.js', {
      symbols: [sym('go', { kind: 'function' }), sym('caller', { kind: 'function' })],
      imports: [{ target: './lib.js', package: null }],
      calls: [{ from: 'caller', name: 'go', line: 1 }],
    }),
  ]);
  assert.deepEqual(edgeSet(g, 'calls'), [`${symbolId('c.js', 'caller')} -> ${symbolId('c.js', 'go')}`]);
});

test('buildGraph: repeated calls collapse into one counted edge', () => {
  const g = buildGraph([file('a.js', {
    symbols: [sym('run', { kind: 'function' }), sym('helper', { kind: 'function' })],
    calls: [1, 2, 3].map((line) => ({ from: 'run', name: 'helper', line })),
  })]);
  const calls = g.edges.filter((e) => e.kind === 'calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].count, 3);
});

// --- projection ------------------------------------------------------------

const SAMPLE = () => buildGraph([
  file('src/animal.js', { symbols: [sym('Animal'), sym('speak', { kind: 'method', parent: 'Animal' })] }),
  file('src/dog.js', {
    symbols: [
      sym('Dog', { extends: ['Animal'] }),
      sym('speak', { kind: 'method', parent: 'Dog' }),
      sym('legs', { kind: 'field', parent: 'Dog' }),
    ],
    imports: [{ target: './animal.js', package: null }],
    calls: [{ from: 'Dog.speak', name: 'bark', line: 5 }],
  }),
  file('src/util/bark.js', { symbols: [sym('Barker'), sym('bark', { kind: 'method', parent: 'Barker' })] }),
]);

test('projectView: the deps view is modules and import edges only', () => {
  const v = projectView(SAMPLE(), { view: 'deps' });
  assert.deepEqual(v.nodes.map((n) => n.kind), ['module', 'module']);
  assert.deepEqual(v.edges.map((e) => e.kind), ['imports']);
});

// --- aggregation: the thing that keeps the overview readable ---------------

test('projectView: the overview shows one level, collapsing subfolders into a box', () => {
  const v = projectView(SAMPLE(), { view: 'overview', focus: 'src' });
  // src holds animal.js, dog.js and the util/ folder — three boxes, not the
  // four files that are actually down there.
  assert.deepEqual(v.nodes.map((n) => n.name).sort(), ['animal.js', 'dog.js', 'util']);
  assert.equal(v.meta.aggregated, true);
});

test('projectView: an aggregate box says how many files it stands for', () => {
  const records = [1, 2, 3].map((i) => file(`src/deep/f${i}.js`, { imports: [{ target: '../root.js', package: null }] }));
  records.push(file('src/root.js'));
  const v = projectView(buildGraph(records), { view: 'overview', focus: 'src' });
  const deep = v.nodes.find((n) => n.name === 'deep');
  assert.equal(deep.absorbed, 3);
  // A box standing for exactly one file must not claim to be an aggregate.
  assert.equal(v.nodes.find((n) => n.name === 'root.js').absorbed, undefined);
});

test('projectView: edges are lifted onto the aggregate boxes', () => {
  const g = buildGraph([
    file('src/a/one.js', { imports: [{ target: '../b/two.js', package: null }] }),
    file('src/a/three.js', { imports: [{ target: '../b/two.js', package: null }] }),
    file('src/b/two.js'),
  ]);
  const v = projectView(g, { view: 'overview', focus: 'src' });
  assert.deepEqual(v.nodes.map((n) => n.name).sort(), ['a', 'b']);
  assert.equal(v.edges.length, 1, 'two file-level imports become one folder-level edge');
  assert.equal(v.edges[0].count, 2);
});

test('projectView: an aggregate box with no cross-folder edges is still shown', () => {
  // A self-contained folder is one of the project's parts. Culling it as an
  // orphan would answer "what is this made of?" by leaving pieces out.
  const g = buildGraph([
    file('src/solo/a.js', { imports: [{ target: './b.js', package: null }] }),
    file('src/solo/b.js'),
    file('src/other/c.js'),
  ]);
  const v = projectView(g, { view: 'overview', focus: 'src' });
  assert.deepEqual(v.nodes.map((n) => n.name).sort(), ['other', 'solo']);
  assert.deepEqual(v.edges, []);
});

test('projectView: the class view draws no box for a method that belongs to no type', () => {
  // Object-literal shorthand methods and module-level functions are method- or
  // field-shaped but are not class members; as loose boxes they are the noise
  // that makes a generated class diagram unreadable.
  const g = buildGraph([file('a.js', {
    symbols: [
      sym('Real'),
      sym('inside', { kind: 'method', parent: 'Real' }),
      sym('loose', { kind: 'method', parent: '' }),
    ],
    calls: [{ from: 'loose', name: 'inside', line: 1, method: true }],
  })]);
  const v = projectView(g, { view: 'classes', passes: { orphans: true } });
  assert.deepEqual(v.nodes.map((n) => n.name), ['Real']);
  assert.deepEqual(v.nodes[0].members.map((m) => m.name), ['inside']);
});

test('projectView: the class view draws members as rows inside their class, not as boxes', () => {
  const v = projectView(SAMPLE(), { view: 'classes', passes: { members: true } });
  const dog = v.nodes.find((n) => n.name === 'Dog');
  assert.deepEqual(dog.members.map((m) => m.name).sort(), ['legs', 'speak']);
  assert.equal(v.nodes.some((n) => n.kind === 'method'), false, 'a method is a row, not a node');
});

test('projectView: hiding members lifts their call onto the owning classes', () => {
  const g = buildGraph([
    file('a.js', { symbols: [sym('A'), sym('run', { kind: 'method', parent: 'A' })], calls: [{ from: 'A.run', name: 'handle', line: 1 }] }),
    file('b.js', { symbols: [sym('B'), sym('handle', { kind: 'method', parent: 'B' })] }),
  ]);
  const v = projectView(g, { view: 'classes', passes: { members: false } });
  const call = v.edges.find((e) => e.kind === 'calls');
  assert.equal(v.nodes.find((n) => n.id === call.from).name, 'A');
  assert.equal(v.nodes.find((n) => n.id === call.to).name, 'B');
  assert.equal(call.lifted, true);
});

test('projectView: pass switches add and remove exactly their own edge kinds', () => {
  const g = SAMPLE();
  const all = projectView(g, { view: 'classes', passes: { inheritance: true, calls: true } });
  assert.ok(all.edges.some((e) => e.kind === 'extends'));
  assert.ok(all.edges.some((e) => e.kind === 'calls'));

  const noCalls = projectView(g, { view: 'classes', passes: { inheritance: true, calls: false } });
  assert.ok(noCalls.edges.some((e) => e.kind === 'extends'));
  assert.equal(noCalls.edges.some((e) => e.kind === 'calls'), false);

  const none = projectView(g, { view: 'classes', passes: { inheritance: false, calls: false, instantiation: false } });
  assert.deepEqual(none.edges, []);
});

test('projectView: externals appear only when their pass is on', () => {
  const g = buildGraph([file('a.js', { symbols: [sym('W', { extends: ['Component'] })] })]);
  assert.equal(projectView(g, { view: 'classes' }).nodes.some((n) => n.kind === 'external'), false);
  assert.equal(projectView(g, { view: 'classes', passes: { externals: true } }).nodes.some((n) => n.kind === 'external'), true);
});

test('projectView: orphans are hidden by default and shown on request', () => {
  const g = buildGraph([
    file('a.js', { symbols: [sym('Lonely')] }),
    file('b.js', { symbols: [sym('Base'), sym('Derived', { extends: ['Base'] })] }),
  ]);
  const hidden = projectView(g, { view: 'classes' });
  assert.equal(hidden.nodes.some((n) => n.name === 'Lonely'), false);
  const shown = projectView(g, { view: 'classes', passes: { orphans: true } });
  assert.equal(shown.nodes.some((n) => n.name === 'Lonely'), true);
});

test('projectView: focus drills into one folder', () => {
  const v = projectView(SAMPLE(), { view: 'deps', focus: 'src/util', passes: { orphans: true } });
  assert.deepEqual(v.nodes.map((n) => n.file), ['src/util/bark.js']);
});

test('projectView: capping keeps the best-connected nodes and reports the loss', () => {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(file(`f${i}.js`, { imports: [{ target: './hub.js', package: null }] }));
  }
  records.push(file('hub.js'));
  const v = projectView(buildGraph(records), { view: 'deps', maxNodes: 5 });
  assert.equal(v.meta.truncated, true);
  assert.equal(v.meta.shown, 5);
  assert.equal(v.meta.total, 31);
  assert.equal(v.nodes.some((n) => n.name === 'hub.js'), true, 'the hub is the most connected node');
});

test('projectView: capping is stable across repeated runs', () => {
  const g = SAMPLE();
  const a = projectView(g, { view: 'deps', maxNodes: 1 }).nodes.map((n) => n.id);
  const b = projectView(g, { view: 'deps', maxNodes: 1 }).nodes.map((n) => n.id);
  assert.deepEqual(a, b);
});

test('projectView: an unknown view falls back to the overview', () => {
  assert.equal(projectView(SAMPLE(), { view: 'nonsense' }).view, 'overview');
});

test('projectView: an empty project projects to an empty diagram, not an error', () => {
  const v = projectView(buildGraph([]), { view: 'classes' });
  assert.deepEqual(v.nodes, []);
  assert.deepEqual(v.edges, []);
  assert.equal(v.meta.total, 0);
});

// --- decluttering ----------------------------------------------------------

const e = (from, to, kind = 'imports') => ({ from, to, kind, count: 1 });

test('transitiveReduction drops an edge a longer path already implies', () => {
  // A→B→C makes the direct A→C pure ink.
  const out = transitiveReduction([e('A', 'B'), e('B', 'C'), e('A', 'C')]);
  assert.deepEqual(out.map((x) => `${x.from}->${x.to}`).sort(), ['A->B', 'B->C']);
});

test('transitiveReduction keeps an edge with no alternative route', () => {
  const out = transitiveReduction([e('A', 'B'), e('C', 'D')]);
  assert.equal(out.length, 2);
});

test('transitiveReduction never breaks a cycle', () => {
  // Every edge of a pure cycle is the only route between its ends, so all
  // survive — a reduction that silently opened cycles would hide the one thing
  // worth reporting.
  const out = transitiveReduction([e('A', 'B'), e('B', 'C'), e('C', 'A')]);
  assert.equal(out.length, 3);
});

test('transitiveReduction treats each edge kind separately', () => {
  // A calls B, B calls C, A *imports* C — the import is not implied by calls.
  const out = transitiveReduction([e('A', 'B', 'calls'), e('B', 'C', 'calls'), e('A', 'C', 'imports')]);
  assert.equal(out.length, 3);
});

test('markCycles flags every edge on a cycle and nothing else', () => {
  const out = markCycles([e('A', 'B'), e('B', 'A'), e('B', 'C')]);
  const cyclic = out.filter((x) => x.cyclic).map((x) => `${x.from}->${x.to}`).sort();
  assert.deepEqual(cyclic, ['A->B', 'B->A']);
});

test('projectView: Simplify is a switch, and reports what it hid', () => {
  const g = buildGraph([
    file('a.js', { imports: [{ target: './b.js', package: null }, { target: './c.js', package: null }] }),
    file('b.js', { imports: [{ target: './c.js', package: null }] }),
    file('c.js'),
  ]);
  const on = projectView(g, { view: 'deps', passes: { simplify: true } });
  assert.equal(on.edges.length, 2);
  assert.equal(on.meta.hiddenEdges, 1);

  const off = projectView(g, { view: 'deps', passes: { simplify: false } });
  assert.equal(off.edges.length, 3);
  assert.equal(off.meta.hiddenEdges, 0);
});

test('projectView: a dependency cycle is reported in meta', () => {
  const g = buildGraph([
    file('a.js', { imports: [{ target: './b.js', package: null }] }),
    file('b.js', { imports: [{ target: './a.js', package: null }] }),
  ]);
  const v = projectView(g, { view: 'deps' });
  assert.equal(v.meta.cycles, 2);
  assert.ok(v.edges.every((x) => x.cyclic));
});

test('projectView: views stay within a budget a reader can actually hold', () => {
  // The guarantee that matters: no view ever hands back hundreds of boxes.
  const records = [];
  for (let i = 0; i < 300; i++) {
    records.push(file(`src/g${i % 20}/f${i}.js`, { imports: [{ target: `../g${(i + 1) % 20}/f${(i + 1) % 300}.js`, package: null }] }));
  }
  const g = buildGraph(records);
  for (const view of ['overview', 'deps', 'calls', 'classes', 'inheritance']) {
    const v = projectView(g, { view });
    assert.ok(v.nodes.length <= 50, `${view} drew ${v.nodes.length} boxes`);
  }
});

// --- helpers ---------------------------------------------------------------

test('liftEdges: drops self-edges created by lifting, and merges duplicates', () => {
  const byId = new Map([
    ['A', { id: 'A', parent: null }],
    ['A.x', { id: 'A.x', parent: 'A' }],
    ['A.y', { id: 'A.y', parent: 'A' }],
    ['B', { id: 'B', parent: null }],
    ['B.z', { id: 'B.z', parent: 'B' }],
  ]);
  const out = liftEdges([
    { from: 'A.x', to: 'A.y', kind: 'calls', count: 1 }, // becomes A -> A, dropped
    { from: 'A.x', to: 'B.z', kind: 'calls', count: 1 },
    { from: 'A.y', to: 'B.z', kind: 'calls', count: 1 }, // merges with the above
  ], new Set(['A', 'B']), byId);
  assert.equal(out.length, 1);
  assert.equal(out[0].from, 'A');
  assert.equal(out[0].to, 'B');
  assert.equal(out[0].count, 2);
});

test('dedupeEdges: same endpoints but different kinds stay separate', () => {
  const out = dedupeEdges([
    { from: 'a', to: 'b', kind: 'calls' },
    { from: 'a', to: 'b', kind: 'imports' },
    { from: 'a', to: 'b', kind: 'calls' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.kind === 'calls').count, 2);
});

test('searchNodes: matches name, path and member names', () => {
  const nodes = [
    { id: '1', name: 'Widget', file: 'src/ui.js', members: [{ name: 'render' }] },
    { id: '2', name: 'Other', file: 'lib/thing.js', members: [] },
  ];
  assert.deepEqual([...searchNodes(nodes, 'widg')], ['1']);
  assert.deepEqual([...searchNodes(nodes, 'render')], ['1']);
  assert.deepEqual([...searchNodes(nodes, 'lib/')], ['2']);
  assert.deepEqual([...searchNodes(nodes, '  ')], []);
});

test('joinRel resolves . and .. against a repo-relative directory', () => {
  assert.equal(joinRel('src/app', './x.js'), 'src/app/x.js');
  assert.equal(joinRel('src/app', '../lib/y.js'), 'src/lib/y.js');
  assert.equal(joinRel('', './top.js'), 'top.js');
  assert.equal(joinRel('a/b/c', '../../d'), 'a/d');
});

test('simpleName takes the last dotted segment', () => {
  assert.equal(simpleName('a.b.C'), 'C');
  assert.equal(simpleName('C'), 'C');
});
