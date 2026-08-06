// Pure geometry and formatting for the Diagram panel. The DOM half lives in
// src/renderer/viewer/diagram/ — everything here is numbers and strings so it
// can be unit-tested without a browser.
//
// Coordinates: the layout arrives from the main process in *diagram space*
// (origin top-left, y down, one unit = one CSS pixel at zoom 1). The panel draws
// it inside an SVG whose viewBox never changes; panning and zooming are one
// transform on a single <g>, which keeps redraws cheap and text crisp.

// The transform that fits a diagram of `size` into a viewport of `vw`x`vh`, with
// a margin, never magnifying past 1:1 (a two-box diagram blown up to fill a
// 4K panel looks broken, not helpful).
export function fitTransform(size, vw, vh, margin = 24) {
  const w = size.width || 0;
  const h = size.height || 0;
  if (!w || !h || !vw || !vh) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min((vw - margin * 2) / w, (vh - margin * 2) / h, 1);
  return { scale, x: (vw - w * scale) / 2, y: (vh - h * scale) / 2 };
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 4;

const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

// Zoom about a fixed point (the cursor), so the thing under the pointer stays
// under the pointer — the behaviour every map and canvas app has trained users
// to expect.
export function zoomAt(t, factor, px, py) {
  const scale = clampScale(t.scale * factor);
  const k = scale / t.scale;
  return { scale, x: px - (px - t.x) * k, y: py - (py - t.y) * k };
}

// Viewport point -> diagram point. Used for hit-testing and for centring on a
// node after a search.
export function toDiagram(t, px, py) {
  return { x: (px - t.x) / t.scale, y: (py - t.y) / t.scale };
}

// The transform that puts `rect` (diagram space) in the middle of the viewport
// at the current scale — what "reveal this node" needs.
export function centerOn(t, rect, vw, vh) {
  return {
    scale: t.scale,
    x: vw / 2 - (rect.x + rect.width / 2) * t.scale,
    y: vh / 2 - (rect.y + rect.height / 2) * t.scale,
  };
}

export const transformAttr = (t) => `translate(${t.x} ${t.y}) scale(${t.scale})`;

// An SVG path through ELK's bend points. Corners are rounded by pulling the
// path in along both incident segments — orthogonal routes with hard 90° angles
// read as a circuit board, which fights the rest of the app's soft edges.
export function edgePath(points, radius = 6) {
  if (!points || points.length < 2) return '';
  if (points.length === 2) return `M ${round(points[0].x)} ${round(points[0].y)} L ${round(points[1].x)} ${round(points[1].y)}`;
  let d = `M ${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
    const a = along(cur, prev, r);
    const b = along(cur, next, r);
    d += ` L ${round(a.x)} ${round(a.y)} Q ${round(cur.x)} ${round(cur.y)} ${round(b.x)} ${round(b.y)}`;
  }
  const last = points[points.length - 1];
  return d + ` L ${round(last.x)} ${round(last.y)}`;
}

const round = (n) => Math.round(n * 10) / 10;
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// The point `r` away from `from`, heading towards `to`.
function along(from, to, r) {
  const d = dist(from, to);
  if (!d) return { x: from.x, y: from.y };
  return { x: from.x + ((to.x - from.x) / d) * r, y: from.y + ((to.y - from.y) / d) * r };
}

// The angle of the final segment, so an arrowhead points the way the edge runs.
export function endAngle(points) {
  if (!points || points.length < 2) return 0;
  const b = points[points.length - 1];
  const a = points[points.length - 2];
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

// UML member row: visibility marker, name, and the signature if it fits.
export function memberLabel(m) {
  const mark = m.visibility === 'private' ? '−' : m.visibility === 'protected' ? '#' : '+';
  return `${mark} ${m.name}${m.signature || ''}`;
}

// Trim a label to fit a box of `width` at the given character width, keeping the
// end of a path (the distinctive part) rather than the start.
export function fitLabel(text, width, charW = 6.6, keepEnd = false) {
  const max = Math.max(1, Math.floor(width / charW));
  if (!text || text.length <= max) return text || '';
  return keepEnd ? '…' + text.slice(text.length - max + 1) : text.slice(0, max - 1) + '…';
}

// Case-insensitive match over name, path and member names. Returns the ids to
// highlight; the panel dims everything else rather than hiding it, so the
// surrounding structure stays readable.
export function matchNodes(nodes, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return null; // null means "no search active", distinct from "no hits"
  const hits = new Set();
  for (const n of nodes) {
    const hay = `${n.name} ${n.file || ''}`.toLowerCase();
    if (hay.includes(q) || (n.members || []).some((m) => m.name.toLowerCase().includes(q))) hits.add(n.id);
  }
  return hits;
}

// An edge is relevant to a search when both of its ends are: a highlighted edge
// leading into a dimmed box reads as a broken link.
export function matchEdges(edges, hits) {
  if (!hits) return null;
  const on = new Set();
  for (const e of edges) if (hits.has(e.from) && hits.has(e.to)) on.add(edgeKey(e));
  return on;
}

export const edgeKey = (e) => `${e.kind} ${e.from} ${e.to}`;

// Breadcrumb trail for the drill-in path: [{ label, focus }], root first.
export function crumbs(focus, rootLabel = 'Project') {
  const out = [{ label: rootLabel, focus: '' }];
  if (!focus) return out;
  let acc = '';
  for (const part of focus.split('/')) {
    if (!part) continue;
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, focus: acc });
  }
  return out;
}

// The folder a double-click should drill into. Drilling into a file would leave
// nothing to expand, so a module resolves to the folder that holds it.
export function drillTarget(node) {
  if (!node) return null;
  if (node.kind === 'folder') return node.file;
  if (node.kind === 'module') {
    const i = (node.file || '').lastIndexOf('/');
    return i < 0 ? '' : node.file.slice(0, i);
  }
  return null;
}
