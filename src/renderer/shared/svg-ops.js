// Pure, DOM-free, Electron-free helpers for the vector editor. Everything the
// editor needs that is plain string/number math lives here so it can be unit
// tested in Node without a canvas or paper.js (the editor shell wires these to
// the live document). Grouped: SVG root-tag parsing, `.ai` magic-byte sniffing,
// z-order array moves, align/distribute deltas, and pan/zoom/snap math.

// --- SVG root <svg> tag: width / height / viewBox -------------------------

// The opening <svg …> tag (first one wins — that's the document root).
function rootTag(svg) {
  const m = /<svg\b[^>]*>/i.exec(svg);
  return m ? { tag: m[0], start: m.index, end: m.index + m[0].length } : null;
}

function readAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}

// Replace an attribute's value in a tag, or insert it before the tag's close
// (handles both `>` and self-closing `/>`).
function writeAttr(tag, name, value) {
  const re = new RegExp(`(\\b${name}\\s*=\\s*)("[^"]*"|'[^']*')`, 'i');
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  return tag.replace(/\s*\/?>$/, (close) => ` ${name}="${value}"${close.trimStart() === '/>' ? '/>' : '>'}`);
}

// Read the root's intrinsic size. Each field is the raw attribute string
// (`"100"`, `"100px"`, `"0 0 64 64"`) or null when absent.
export function parseSvgSize(svg) {
  const r = rootTag(svg);
  if (!r) return { width: null, height: null, viewBox: null };
  return {
    width: readAttr(r.tag, 'width'),
    height: readAttr(r.tag, 'height'),
    viewBox: readAttr(r.tag, 'viewBox'),
  };
}

// Re-stamp width/height/viewBox onto the root tag. Only keys present (non-null,
// non-undefined) in `size` are applied — so a viewBox-only document stays that
// way. Used on save to restore the dimensions paper.js's exportSVG may drop.
export function applySvgSize(svg, size) {
  const r = rootTag(svg);
  if (!r || !size) return svg;
  let tag = r.tag;
  for (const name of ['width', 'height', 'viewBox']) {
    const v = size[name];
    if (v !== null && v !== undefined) tag = writeAttr(tag, name, v);
  }
  return svg.slice(0, r.start) + tag + svg.slice(r.end);
}

// Guarantee the SVG namespace (and xmlns:xlink when an `xlink:` reference is
// present) so a saved file opens everywhere — a bare exportSVG fragment can omit
// xmlns when embedded, but a standalone file needs it.
export function ensureSvgXmlns(svg) {
  const r = rootTag(svg);
  if (!r) return svg;
  let tag = r.tag;
  if (!/\bxmlns\s*=/.test(tag)) tag = writeAttr(tag, 'xmlns', 'http://www.w3.org/2000/svg');
  if (/\bxlink:/.test(svg) && !/\bxmlns:xlink\s*=/.test(tag)) tag = writeAttr(tag, 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return svg.slice(0, r.start) + tag + svg.slice(r.end);
}

// --- .ai file sniffing ----------------------------------------------------

const stripPreamble = (head) => { const s = String(head); return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; };

// Modern .ai is a PDF wrapper (`%PDF-`); legacy .ai is PostScript (`%!PS-Adobe`).
// Tolerant of a leading BOM and a short binary preamble (scan the first 1KB).
export function aiKind(head) {
  const h = stripPreamble(head);
  if (h.startsWith('%PDF-')) return 'pdf';
  if (h.startsWith('%!PS') || h.startsWith('%!Adobe')) return 'postscript';
  const probe = h.slice(0, 1024);
  if (probe.includes('%PDF-')) return 'pdf';
  if (probe.includes('%!PS')) return 'postscript';
  return 'unknown';
}

// Best-effort metadata for the .ai info card. All fields nullable.
//  - creator: the `%%Creator:` line or an XMP <xmp:CreatorTool>
//  - version: PDF version for pdf, Illustrator/PS version for postscript
//  - width/height: PDF /MediaBox or PS %%BoundingBox extent, in points
export function aiInfo(head) {
  const h = stripPreamble(head);
  const kind = aiKind(h);
  const first = (re) => { const m = re.exec(h); return m ? m[1].trim() : null; };

  let creator = first(/%%Creator:\s*([^\r\n]+)/);
  if (!creator) creator = first(/<xmp:CreatorTool>\s*([^<]+)<\/xmp:CreatorTool>/i);

  let version = null;
  if (kind === 'pdf') { const v = first(/%PDF-(\d+\.\d+)/); version = v ? `PDF ${v}` : null; }
  else if (kind === 'postscript') { version = first(/%!PS-Adobe-[\d.]+\s+([^\r\n]+)/) || first(/Illustrator[^\d]*([\d.]+)/i); }

  let width = null, height = null;
  const box = (re) => { const m = re.exec(h); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null; };
  const media = box(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/)
    || box(/%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (media && media.every((n) => Number.isFinite(n))) {
    width = Math.abs(media[2] - media[0]);
    height = Math.abs(media[3] - media[1]);
  }
  return { kind, version, creator, width, height };
}

// --- z-order (paint order: later == on top == "front") --------------------
// Each takes a plain order array (ids or indices) and returns a NEW array; an
// out-of-range index returns an unchanged copy.

const moveTo = (order, from, to) => {
  const a = order.slice();
  if (from < 0 || from >= a.length) return a;
  const clamped = Math.max(0, Math.min(a.length - 1, to));
  const [item] = a.splice(from, 1);
  a.splice(clamped, 0, item);
  return a;
};

export function moveItem(order, from, to) { return moveTo(order, from, to); }
export function bringToFront(order, i) { return moveTo(order, i, order.length - 1); }
export function sendToBack(order, i) { return moveTo(order, i, 0); }
export function forwardOne(order, i) { return moveTo(order, i, i + 1); }
export function backwardOne(order, i) { return moveTo(order, i, i - 1); }

// --- align / distribute ---------------------------------------------------
// `bounds`: array of { x, y, width, height }. Returns a parallel array of
// { dx, dy } translations to apply. Centers/edges align to the union bounds;
// distribute spaces item centers evenly between the extreme items.

export function alignOffsets(bounds, mode) {
  const deltas = bounds.map(() => ({ dx: 0, dy: 0 }));
  const n = bounds.length;
  if (n === 0) return deltas;
  const cx = bounds.map((b) => b.x + b.width / 2);
  const cy = bounds.map((b) => b.y + b.height / 2);
  const minX = Math.min(...bounds.map((b) => b.x));
  const maxX = Math.max(...bounds.map((b) => b.x + b.width));
  const minY = Math.min(...bounds.map((b) => b.y));
  const maxY = Math.max(...bounds.map((b) => b.y + b.height));

  const spread = (axisCenter, set) => {
    if (n <= 2) return;
    const idx = [...Array(n).keys()].sort((a, b) => axisCenter[a] - axisCenter[b]);
    const first = idx[0], last = idx[n - 1];
    const step = (axisCenter[last] - axisCenter[first]) / (n - 1);
    idx.forEach((id, k) => set(id, axisCenter[first] + step * k - axisCenter[id]));
  };

  switch (mode) {
    case 'left': bounds.forEach((b, i) => { deltas[i].dx = minX - b.x; }); break;
    case 'right': bounds.forEach((b, i) => { deltas[i].dx = maxX - (b.x + b.width); }); break;
    case 'hcenter': { const c = (minX + maxX) / 2; bounds.forEach((b, i) => { deltas[i].dx = c - cx[i]; }); break; }
    case 'top': bounds.forEach((b, i) => { deltas[i].dy = minY - b.y; }); break;
    case 'bottom': bounds.forEach((b, i) => { deltas[i].dy = maxY - (b.y + b.height); }); break;
    case 'vcenter': { const c = (minY + maxY) / 2; bounds.forEach((b, i) => { deltas[i].dy = c - cy[i]; }); break; }
    case 'dist-h': spread(cx, (id, dx) => { deltas[id].dx = dx; }); break;
    case 'dist-v': spread(cy, (id, dy) => { deltas[id].dy = dy; }); break;
    default: break;
  }
  return deltas;
}

// --- pan / zoom / snap ----------------------------------------------------

// Snap a point to the nearest grid intersection (no-op when step ≤ 0).
export function snapPoint(pt, step) {
  if (!step || step <= 0) return { x: pt.x, y: pt.y };
  return { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step };
}

// New view center that keeps the project-space `point` under the cursor while
// zooming oldZoom → newZoom. Derived from (p − c)·z being constant on screen.
export function zoomToward(center, oldZoom, newZoom, point) {
  const beta = oldZoom / newZoom;
  return {
    x: point.x - (point.x - center.x) * beta,
    y: point.y - (point.y - center.y) * beta,
  };
}
