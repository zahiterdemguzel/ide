// --- diagram: layout adapter (pure) ---
// Between the projected graph and elkjs. Two halves, both plain data:
//   toElk()    projected view -> the ELK graph JSON, including the box size we
//              want each node drawn at (ELK positions boxes, it does not know
//              how wide a class name or a method list renders).
//   fromElk()  ELK's answer -> absolute coordinates. ELK reports children
//              relative to their parent and edge points relative to the edge's
//              container; the renderer wants one flat coordinate space, so the
//              nesting is resolved here rather than in the painter.
//
// Sizing constants mirror src/styles/diagram.css. They are duplicated on
// purpose: layout has to happen in the main process, where no DOM exists to
// measure text with. Keep the two in sync when the stylesheet's font-size or
// row height changes.

const CHAR_W = 6.6;       // average advance of the 11px UI font
const PAD_X = 18;         // horizontal padding inside a box
const HEADER_H = 26;      // class/module name band
const ROW_H = 16;         // one member row
const MIN_W = 96;
const MAX_W = 280;
const MAX_ROWS = 12;      // members listed before an "+N more" row

// Per-view layout options. `layered` (Sugiyama) is right for anything with a
// direction — imports, calls, inheritance all flow one way. `mrtree` draws a
// tidier pure hierarchy, which is what the inheritance view is.
const LAYOUT = {
  overview: {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
    'elk.layered.spacing.nodeNodeBetweenLayers': '90',
    'elk.spacing.nodeNode': '34',
  },
  classes: {
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '36',
  },
  deps: {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
    'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    'elk.spacing.nodeNode': '20',
  },
  calls: {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '18',
  },
  inheritance: {
    'elk.algorithm': 'mrtree', 'elk.direction': 'DOWN',
    'elk.spacing.nodeNode': '30',
  },
};

const COMMON = {
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const textW = (s) => (s ? s.length * CHAR_W : 0);

// How big a box has to be to hold its own label and member rows. Member rows are
// what make a class diagram legible, so they drive the width too.
function sizeOf(node) {
  const rows = visibleMembers(node);
  const labels = [node.name, subLabel(node), ...rows.map((m) => memberLabel(m))].filter(Boolean);
  const width = clamp(Math.max(...labels.map(textW)) + PAD_X * 2, MIN_W, MAX_W);
  const extra = (node.members || []).length > MAX_ROWS ? 1 : 0;
  const sub = subLabel(node) ? ROW_H : 0;
  const height = HEADER_H + sub + (rows.length + extra) * ROW_H + (rows.length || extra ? 8 : 0);
  return { width: Math.round(width), height: Math.round(height) };
}

// The second line on a box that stands for more than itself — an aggregate
// folder says how many files it holds, so a single box is never mistaken for a
// single file.
function subLabel(node) {
  if (node.absorbed > 1) return `${node.absorbed} files`;
  if (node.kind === 'interface') return '«interface»';
  return '';
}

function visibleMembers(node) {
  return (node.members || []).slice(0, MAX_ROWS);
}

// The text a member row renders as — mirrored by the renderer so the width the
// layout reserved is the width the row actually needs.
function memberLabel(m) {
  const mark = m.visibility === 'private' ? '-' : m.visibility === 'protected' ? '#' : '+';
  return `${mark} ${m.name}${m.signature || ''}`;
}

// Build the ELK graph. Nodes carrying a `parent` become ELK children of that
// parent, which is what draws the overview's folder boxes as real containers.
function toElk(view) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const elkById = new Map();
  const roots = [];

  // Every node is a plain box. The views aggregate rather than nest: showing one
  // level at a time and drilling in reads far better than a nest of compound
  // boxes, which on a real project degenerates into a wall of tiny rectangles.
  for (const node of view.nodes) {
    const elk = { id: node.id, ...sizeOf(node) };
    elkById.set(node.id, elk);
    roots.push(elk);
  }

  // ELK edges carry only ids, so the semantic edge (kind, count, line) is kept
  // alongside in `edgeMeta`, indexed by the same position — built in one pass so
  // the two can never drift apart.
  const edges = [];
  const edgeMeta = [];
  for (const e of view.edges) {
    if (!elkById.has(e.from) || !elkById.has(e.to)) continue;
    edges.push({ id: `e${edgeMeta.length}`, sources: [e.from], targets: [e.to] });
    edgeMeta.push(e);
  }

  const graph = {
    id: 'root',
    layoutOptions: { ...COMMON, ...(LAYOUT[view.view] || LAYOUT.classes) },
    children: roots,
    edges,
  };
  return { graph, edgeMeta, byId };
}

// Flatten ELK's nested, parent-relative result into absolute coordinates.
// `edgeMeta` is the array toElk() returned alongside the graph.
function fromElk(laidOut, view, edgeMeta = []) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const nodes = [];
  const offsets = new Map(); // node id -> its absolute origin, for edge sections

  (function walk(children, ox, oy) {
    for (const child of children || []) {
      const x = ox + (child.x || 0);
      const y = oy + (child.y || 0);
      const src = byId.get(child.id);
      if (src) {
        nodes.push({
          ...src,
          x, y,
          width: child.width || MIN_W,
          height: child.height || HEADER_H,
          sub: subLabel(src),
          members: visibleMembers(src),
          hiddenMembers: Math.max(0, (src.members || []).length - MAX_ROWS),
        });
      }
      offsets.set(child.id, { x, y });
      walk(child.children, x, y);
    }
  })(laidOut.children, 0, 0);

  // Edge points are relative to the edge's container node (absent = root).
  const containerOrigin = (id) => (id && id !== 'root' && offsets.get(id)) || { x: 0, y: 0 };
  const edges = [];
  for (const e of laidOut.edges || []) {
    const semantic = edgeMeta[Number(String(e.id).slice(1))];
    if (!semantic) continue;
    const origin = containerOrigin(e.container);
    const points = [];
    for (const s of e.sections || []) {
      points.push(s.startPoint, ...(s.bendPoints || []), s.endPoint);
    }
    edges.push({
      ...semantic,
      points: points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })),
    });
  }

  return {
    view: view.view,
    nodes,
    edges,
    width: Math.ceil(laidOut.width || 0),
    height: Math.ceil(laidOut.height || 0),
    meta: view.meta,
  };
}

module.exports = {
  CHAR_W, PAD_X, HEADER_H, ROW_H, MIN_W, MAX_W, MAX_ROWS, LAYOUT, COMMON,
  sizeOf, subLabel, memberLabel, visibleMembers, toElk, fromElk,
};
