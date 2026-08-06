import { edgePath, memberLabel, fitLabel, transformAttr } from '../../shared/diagram-view.js';

// --- diagram painter ---
// Turns the positioned graph the main process sent into SVG. Nothing here
// computes geometry: every x/y/width/height already came from the ELK layout, so
// this module is a straight translation into elements. Colours come from the
// theme's CSS variables via class names (src/styles/diagram.css) so the diagram
// re-themes with the rest of the app and never hardcodes one.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  return node;
};

// Sizing constants that must agree with src/main/diagram-elk.js — the layout
// reserved space using those numbers, so drawing with different ones would spill
// text out of its box.
const HEADER_H = 26;
const ROW_H = 16;
const PAD_X = 18;
const CHAR_W = 6.6;

// One marker per edge kind. UML's vocabulary is worth keeping: a hollow triangle
// for generalization, a plain arrow for a dependency, a filled one for a call.
const MARKERS = [
  { id: 'dg-arrow-extends', path: 'M 0 0 L 10 5 L 0 10 z', cls: 'dg-mk-extends', refX: 10 },
  { id: 'dg-arrow-implements', path: 'M 0 0 L 10 5 L 0 10 z', cls: 'dg-mk-implements', refX: 10 },
  { id: 'dg-arrow-imports', path: 'M 0 0 L 9 5 L 0 10', cls: 'dg-mk-imports', refX: 9 },
  { id: 'dg-arrow-calls', path: 'M 0 1 L 9 5 L 0 9 z', cls: 'dg-mk-calls', refX: 9 },
  { id: 'dg-arrow-instantiates', path: 'M 0 5 L 5 1 L 10 5 L 5 9 z', cls: 'dg-mk-instantiates', refX: 10 },
];

function defs() {
  const d = el('defs');
  for (const m of MARKERS) {
    const marker = el('marker', {
      id: m.id, viewBox: '0 0 10 10', refX: m.refX, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    });
    marker.appendChild(el('path', { d: m.path, class: m.cls }));
    d.appendChild(marker);
  }
  return d;
}

export function createSvg() {
  const svg = el('svg', { id: 'diagram-svg', xmlns: NS });
  svg.appendChild(defs());
  const root = el('g', { id: 'diagram-root' });
  root.appendChild(el('g', { class: 'dg-edges' }));
  root.appendChild(el('g', { class: 'dg-nodes' }));
  svg.appendChild(root);
  return svg;
}

export function applyTransform(svg, t) {
  svg.querySelector('#diagram-root').setAttribute('transform', transformAttr(t));
}

// Paint a whole diagram. Folders are drawn first so their children land on top
// of them — ELK returns a flat list, and paint order is the only depth SVG has.
export function render(svg, diagram) {
  const edges = svg.querySelector('.dg-edges');
  const nodes = svg.querySelector('.dg-nodes');
  edges.replaceChildren();
  nodes.replaceChildren();

  for (const edge of diagram.edges) edges.appendChild(drawEdge(edge));
  for (const node of diagram.nodes) nodes.appendChild(drawBox(node));
}

function drawEdge(edge) {
  const g = el('g', {
    class: `dg-edge kind-${edge.kind}${edge.cyclic ? ' is-cyclic' : ''}`,
    'data-key': `${edge.kind} ${edge.from} ${edge.to}`,
  });
  const path = el('path', {
    d: edgePath(edge.points),
    'marker-end': `url(#dg-arrow-${edge.kind})`,
  });
  g.appendChild(path);
  // A repeated relationship is worth showing — 12 calls between two classes is a
  // different fact from 1 — but only once it is more than a single edge.
  if (edge.count > 1 && edge.points && edge.points.length) {
    const mid = edge.points[Math.floor(edge.points.length / 2)];
    g.appendChild(text(mid.x + 4, mid.y - 4, String(edge.count), 'dg-edge-count'));
  }
  const tip = el('title');
  tip.textContent = `${edge.kind}${edge.count > 1 ? ` ×${edge.count}` : ''}${edge.cyclic ? ' (part of a cycle)' : ''}`;
  g.appendChild(tip);
  return g;
}

function text(x, y, content, cls) {
  const t = el('text', { x, y, class: cls });
  t.textContent = content;
  return t;
}

// Every node is a box: a title band, an optional second line saying what the box
// stands for, then one row per member.
function drawBox(node) {
  const g = el('g', {
    class: `dg-node kind-${node.kind}`,
    'data-id': node.id,
    'data-file': node.file || '',
    'data-line': node.line || 1,
    transform: `translate(${node.x} ${node.y})`,
  });
  g.appendChild(el('rect', { class: 'dg-box', x: 0, y: 0, width: node.width, height: node.height, rx: 6 }));

  const title = fitLabel(node.name, node.width - PAD_X * 2, CHAR_W, node.kind === 'module');
  g.appendChild(text(node.width / 2, HEADER_H / 2 + 4, title, 'dg-title'));

  // The second line says what the box stands for: «interface», or how many files
  // an aggregated folder holds. A box that silently represented 90 files would
  // read as one file.
  const subH = node.sub ? ROW_H : 0;
  if (node.sub) g.appendChild(text(node.width / 2, HEADER_H + ROW_H - 5, node.sub, 'dg-sub'));

  const members = node.members || [];
  if (members.length || node.hiddenMembers) {
    g.appendChild(el('line', { class: 'dg-sep', x1: 0, y1: HEADER_H + subH, x2: node.width, y2: HEADER_H + subH }));
    let y = HEADER_H + subH + ROW_H - 4;
    for (const m of members) {
      const row = text(10, y, fitLabel(memberLabel(m), node.width - 20), `dg-row is-${m.kind}${m.static ? ' is-static' : ''}`);
      row.setAttribute('data-line', m.line || node.line || 1);
      g.appendChild(row);
      y += ROW_H;
    }
    if (node.hiddenMembers) g.appendChild(text(10, y, `+${node.hiddenMembers} more`, 'dg-row is-more'));
  }

  const tip = el('title');
  tip.textContent = [node.name, node.file, node.signature].filter(Boolean).join('\n');
  g.appendChild(tip);
  return g;
}

// Search highlighting: dim everything that did not match rather than removing
// it, so the hits stay in context. `hits === null` means no search is active.
export function applyHighlight(svg, hits, edgeHits) {
  svg.classList.toggle('is-searching', !!hits);
  for (const g of svg.querySelectorAll('.dg-node')) {
    g.classList.toggle('is-hit', !!hits && hits.has(g.dataset.id));
  }
  for (const g of svg.querySelectorAll('.dg-edge')) {
    g.classList.toggle('is-hit', !!edgeHits && edgeHits.has(g.dataset.key));
  }
}
