import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the center pane's lazy loading (see viewer/center.js): the non-text
// viewers (asset/sheet/db/web) and their heavy libraries (three.js, paper.js,
// SheetJS, pdf.js, pdf-lib) must only be reachable through dynamic import(),
// never through the renderer's eager static-import graph. A stray top-level
// `import ... from './asset/index.js'` anywhere on the startup path would
// silently drag megabytes back into app startup — this test walks the real
// static graph from the renderer entry to catch that.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'src/renderer/index.js');

// Bare specifiers (npm packages) that must never appear on the eager graph.
const HEAVY_PACKAGES = ['three', 'xlsx', 'paper', 'pdfjs-dist', 'pdf-lib'];

// Renderer modules that must only load via import() in viewer/center.js.
const LAZY_MODULES = [
  resolve(root, 'src/renderer/viewer/asset/index.js'),
  resolve(root, 'src/renderer/viewer/sheet/index.js'),
  resolve(root, 'src/renderer/viewer/db/index.js'),
  resolve(root, 'src/renderer/viewer/web.js'),
];

// Matches top-level static imports (with or without bindings) and re-exports;
// dynamic import(...) is deliberately not matched.
const STATIC_IMPORT_RE = /^\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function staticImports(file) {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(STATIC_IMPORT_RE)].map((m) => m[1]);
}

function walkEagerGraph(entryFile) {
  const seen = new Set();
  const bare = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      if (spec.startsWith('.')) stack.push(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  }
  return { files: seen, bare };
}

test('renderer startup graph reaches no lazy viewer module or heavy library', () => {
  const { files, bare } = walkEagerGraph(entry);
  // Sanity check the walker actually traversed the graph: the center
  // coordinator is on the eager path, so if it's missing the regex broke and
  // the assertions below would pass vacuously.
  assert.ok(files.has(resolve(root, 'src/renderer/viewer/center.js')), 'walker failed to reach viewer/center.js');
  for (const mod of LAZY_MODULES) {
    assert.ok(!files.has(mod), `${mod.split(sep).slice(-3).join('/')} is eagerly imported from the renderer entry`);
  }
  for (const pkg of HEAVY_PACKAGES) {
    const hit = [...bare].find((s) => s === pkg || s.startsWith(pkg + '/'));
    assert.equal(hit, undefined, `heavy package "${hit}" is eagerly imported from the renderer entry`);
  }
});

test('each lazy viewer defers its heavy library to first use', () => {
  // Walking the eager graph *from each lazy module* proves the second layer of
  // laziness: opening a sheet must not load three.js, opening the asset view
  // must not load SheetJS, and the truly heavy libs (xlsx, pdfjs, pdf-lib,
  // paper) load only when their specific sub-view is used.
  const expectations = [
    // [lazy entry, packages allowed on its own eager graph]
    [resolve(root, 'src/renderer/viewer/sheet/index.js'), []],
    [resolve(root, 'src/renderer/viewer/db/index.js'), []],
    [resolve(root, 'src/renderer/viewer/web.js'), []],
    // asset/index.js dynamically imports model/pdf/vector sub-views, so even
    // three.js stays off its eager graph.
    [resolve(root, 'src/renderer/viewer/asset/index.js'), []],
  ];
  for (const [lazyEntry, allowed] of expectations) {
    const { bare } = walkEagerGraph(lazyEntry);
    const heavy = [...bare].filter((s) => HEAVY_PACKAGES.some((p) => s === p || s.startsWith(p + '/')));
    assert.deepEqual(heavy.sort(), allowed, `${lazyEntry.split(sep).slice(-2).join('/')} eagerly imports: ${heavy}`);
  }
});
