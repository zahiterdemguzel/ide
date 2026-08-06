# Diagram panel

A center-area overlay (opened from the `#diagram-btn` toolbar button, exactly like the [browser](architecture.md#browser-panel)) that draws the open project's structure: what classes exist, what they inherit from, which module imports which, and what calls what. It exists so someone dropped into an unfamiliar repo can see its shape without reading it file by file.

**It is always freshly built.** Opening the panel re-indexes, and the ⟳ button re-indexes bypassing the cache. A diagram that quietly describes an older version of the project is worse than no diagram.

## Where the work happens

Parsing a whole project and running a graph layout are both CPU-bound, so both run on a **worker thread** — the same arrangement (and the same failure handling) as [`db.js` ↔ `db-worker.js`](architecture.md#database-viewer).

| File | Role |
|---|---|
| `src/main/diagram.js` | Thin main-side proxy. Lazily spawns the worker, correlates `{id, method, args}` messages, fails in-flight calls and drops a crashed worker. Registers `diagram-build` and `diagram-layout` on the [remote bridge](remote-access.md). |
| `src/main/diagram-worker.js` | Owns the tree-sitter wasm grammars, the file walk, the per-file parse cache, and the elkjs call. No Electron imports. |
| `src/main/diagram-extract.js` | **Pure.** Per-language queries + the capture→symbol mapping, and the hand-written GDScript scanner. |
| `src/main/diagram-lib.js` | **Pure.** Extraction records → the complete graph (`buildGraph`), and graph → one view's nodes and edges (`projectView`). |
| `src/main/diagram-elk.js` | **Pure.** Graph → ELK JSON (box sizing, per-view algorithm), and ELK's nested result → absolute coordinates. |
| `src/renderer/viewer/diagram/` | `index.js` (panel lifecycle, toolbar, state), `svg.js` (painter), `viewport.js` (pan/zoom). |
| `src/renderer/shared/diagram-view.js` | **Pure.** Viewport math, edge paths, label fitting, search matching, breadcrumbs. |
| `src/styles/diagram.css` | Panel + diagram styling. All colours from theme variables. |

**Two IPC channels, because they cost very different amounts.** `diagram-build` is the only call that touches disk; `diagram-layout` re-projects the index already in the worker's memory. That split is what makes flipping a pass switch instant — it never re-parses a file. Builds go through `createCoalescer` ([`concurrency.js`](architecture.md#concurrency-helpers)), so a burst of opens and ⟳ clicks costs at most two index passes; a `force` request in the burst is tracked as a sticky flag so the ⟳'s promise of a fresh read survives being coalesced with a plain open.

## Languages

Six go through **tree-sitter** wasm grammars (`web-tree-sitter` + `@repomix/tree-sitter-wasms`, which is built against a matching tree-sitter CLI — the older `tree-sitter-wasms` package ships grammars whose dylink metadata the current runtime rejects):

`javascript` · `typescript` · `tsx` · `python` · `java` · `c_sharp` · `cpp` (also used for C and all header extensions)

**GDScript has no prebuilt wasm grammar** (its npm package ships C sources only, and its releases carry no wasm asset), so `extractGdscript` in `diagram-extract.js` is a hand-written line scanner. It is the whole implementation for the language and is tested on its own terms. A `.gd` file *is* a class: its name comes from `class_name` or the file stem, `extends` gives the supertype, `func`/`var`/`const`/`signal` are members, `preload`/`load` are imports, and `Klass.new()` is an instantiation.

Queries are hand-written per language rather than reusing each grammar's `queries/tags.scm`: tags label definitions and references but say nothing about **inheritance**, which is half of what a class diagram is for. Captures follow one convention (`@def.<kind>`, `@name`, `@super`, `@iface`, `@call`, `@call.method`, `@new`, `@import`) so a single walker handles every language, and nesting is derived from tree position rather than from the query.

### Two accuracy decisions worth knowing

- **`@call` vs `@call.method`.** A receiver call (`s.trim()`) is only ever a method, so it may not resolve to a same-named free function. Without this, every `.trim()` in a project hangs an edge on a top-level `function trim()` — which is exactly what happened before the split was introduced.
- **C# base lists.** `class Dog : Animal, IGreeter` is one undifferentiated list in the grammar, so the base class and the interfaces are split by the `I[A-Z]` naming convention. It is a heuristic, and it is the only one in the extractor.

## Resolution

`buildGraph` resolves a written name to a definition in this order: **same file → a file this one imports → globally unique → same folder**. Anything still ambiguous resolves to *nothing*: a missing edge is much cheaper than a confidently wrong one. Imports are resolved first precisely because they are the evidence the call and inheritance passes lean on. Unresolved supertypes and instantiations become `external` nodes rather than vanishing; bare import specifiers become one `package` node per package.

## Legibility is the design constraint

**This is the most important thing to understand about `projectView`, and the easiest to accidentally undo.**

The first working version drew 374 boxes and 672 edges for this repo's Overview, taking 1.8s to lay out. It was complete, correct, and useless — a hairball. The whole projection pipeline exists to prevent that, in this order:

1. **focus** — restrict to a subtree. Drilling in is how depth is reached.
2. **aggregate** — in an aggregating view, every node is represented by its ancestor *one level below the focus*. A folder of 90 files becomes one box labelled `main · 83 files`. This is what turns 374 boxes into 6.
3. **lift** — `liftEdges` re-hangs the edges of anything hidden onto whatever survived, so the relationships stay true at the level being shown. `A.run() calls B.handle()` becomes `A calls B`; two file-level imports across a folder boundary become one folder-level edge with `count: 2`.
4. **reduce** — `transitiveReduction` drops dependency edges a longer path already implies (A→B→C makes A→C pure ink). On this repo's `src/main` that is 104 edges down to 55. Per edge kind, and never on an edge with no alternative route, so **cycles survive intact**.
5. **cap** — keep the best-connected, and say so.

Result on this repo: root Overview is 6 boxes / 3 edges, `src` is 4 boxes, `src/renderer/viewer` is 10. Every view lays out in under 200 ms.

**The budgets are small on purpose** (`VIEW_MAX_NODES`: 30–50). A diagram stops being readable long before it stops being drawable. If you find yourself raising these because something is "missing", the answer is almost always drill-in or a different view.

### Rules that are easy to break

- **Aggregate views never hide orphans.** A self-contained folder is still one of the project's parts; culling it answers "what is this made of?" by leaving pieces out. Only detail views cull unconnected nodes.
- **The class view draws no box for a method owned by no type** (`strayMember`). Object-literal shorthand methods and module-level functions are method-shaped but are not class members, and as loose boxes they are exactly the noise that makes a generated class diagram unreadable.
- **Every measurement — degree, orphan detection, the cap — is taken on the boxes that will actually be drawn**, not on the raw graph. Otherwise a class whose only relationships come from its methods counts as an orphan and disappears.
- **Views aggregate rather than nest.** Compound/nested boxes were tried and removed: on a real project they degenerate into a wall of tiny rectangles. One level plus drill-in reads far better.

## Views and passes

Five diagram types (`VIEWS`), each with its own ELK algorithm and node budget:

| View | Shows | Aggregates | Reduced |
|---|---|---|---|
| `overview` | one level of the focus — the project map | yes | yes |
| `classes` | UML boxes with member rows, types only | no | no |
| `deps` | every file under the focus, import edges | no | yes |
| `calls` | functions/methods, call edges | no | no |
| `inheritance` | type hierarchy (`mrtree`) | no | no |

Eight pass switches (`PASSES`): inheritance, imports, calls, instantiation, members, **simplify**, externals, orphans. Externals and orphans start **off** — a first look at a project should be its own shape, not every package it touches. Simplify starts **on**; it is the transitive reduction, exposed as a switch because it does hide real edges and the user should be able to see them.

## Honesty surface

The status line reports, in one place: that the view is aggregated, capping (`showing the N most connected of M`), how many implied edges Simplify hid, how many edges sit in a **dependency cycle** (drawn in red, and the one thing in a dependency graph always worth pointing at), and any unreadable files. Aggregate boxes carry a `N files` sub-label so a box is never mistaken for a single file.

Capping keeps the **best-connected** nodes with ties broken by id, so a refresh is stable. Nothing is ever silently truncated.

## State

Per-repo in `localStorage` under `diagram.state:<repo path>` (the same convention as the browser's address history): the selected view, the pass switches, and the drill-in path. **The graph itself is never persisted** — it is always rebuilt.

## Gotchas

- The panel must stay reachable only through `center.js`'s lazy `importers` map. A static import from `src/renderer/index.js` would put tree-sitter-sized work on the startup path and fail `test/lazy-viewers.test.mjs`.
- `viewer/diagram/index.js` imports `center.js` **dynamically** inside the click handler — center.js is what loads this module, so a static import would close the cycle at load time.
- Sizing constants are duplicated between `diagram-elk.js` (which reserves the space, in the main process where there is no DOM to measure text with) and `svg.js`/`diagram.css` (which draw it). Change them together or text spills out of its boxes. The `subLabel` second line is part of that height budget.
- Adding a language means: a row in `LANG_BY_EXT`, a query in `QUERIES`, the grammar present in `@repomix/tree-sitter-wasms`, and a sample row in `test/diagram-extract.test.js` — which asserts against the *real* grammar, so a grammar bump that silently stops matching is caught.
