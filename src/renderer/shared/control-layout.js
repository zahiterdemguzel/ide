import { nodeSections, nodePathOf, attrStr, getAttr, getProp, parseNums } from './tscn.js';
import { isControlType, isNode2DType } from './scene-kind.js';
import {
  anchorsOf, offsetsOf, rectOf, growDirsOf, sizeFlagsOf, customMinSizeOf,
  pivotOf, scaleOf, rotationOf, visibleOf,
  SIZE_FILL, SIZE_EXPAND, SIZE_SHRINK_CENTER, SIZE_SHRINK_END,
} from './tscn-layout.js';

// The layout engine: turns a parsed .tscn into absolute on-screen rectangles.
// One bottom-up minimum-size pass, then one top-down placement pass, so the
// whole scene re-lays out in O(nodes) — cheap enough to run on every pointer
// move during a drag. DOM-free: text/texture measurement is injected as a
// `measure` callback, because only the painter knows how wide a string is.

// --- tree -------------------------------------------------------------------

export function buildControlTree(doc) {
  const byPath = new Map();
  let root = null;
  for (const node of nodeSections(doc)) {
    const type = attrStr(node, 'type');
    const instance = getAttr(node, 'instance');
    const path = nodePathOf(node);
    const entry = {
      path,
      name: attrStr(node, 'name') || '',
      type,
      node,
      instance,
      kind: isControlType(type) ? 'control' : isNode2DType(type) ? 'node2d' : 'other',
      children: [],
    };
    byPath.set(path, entry);
    if (!root) { root = entry; continue; }
    const parent = byPath.get(attrStr(node, 'parent')) || root;
    parent.children.push(entry);
  }
  return root;
}

// --- containers -------------------------------------------------------------

export const CONTAINER_TYPES = new Set([
  'BoxContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'MarginContainer', 'PanelContainer', 'AspectRatioContainer',
  'ScrollContainer', 'SplitContainer', 'HSplitContainer', 'VSplitContainer',
  'TabContainer', 'HFlowContainer', 'VFlowContainer', 'FlowContainer',
]);
export function isContainerType(type) { return CONTAINER_TYPES.has(type); }

// Godot's default theme constants the layout actually depends on.
const THEME = {
  boxSeparation: 4,
  gridHSeparation: 4,
  gridVSeparation: 4,
  panelMargin: 0,
  splitSeparation: 12,
  tabBarHeight: 31,
};

// theme_override_constants/<name>, falling back to the default theme.
function constantOf(node, name, def) {
  const raw = getProp(node, `theme_override_constants/${name}`);
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function num(node, key, def) {
  const n = Number(getProp(node, key));
  return Number.isFinite(n) ? n : def;
}

const isVerticalBox = (entry) => entry.type === 'VBoxContainer'
  || (entry.type === 'BoxContainer' && getProp(entry.node, 'vertical') === 'true');
const isVerticalSplit = (entry) => entry.type === 'VSplitContainer'
  || (entry.type === 'SplitContainer' && getProp(entry.node, 'vertical') === 'true');

// Children a container positions: visible Controls only. A Node2D or a plain
// Node inside a container is not laid out by it.
function laidOutChildren(entry) {
  return entry.children.filter((c) => c.kind === 'control' && visibleOf(c.node));
}

// --- minimum size -----------------------------------------------------------

// Combined minimum size, Godot's rule: the node's own content minimum maxed
// with `custom_minimum_size`. Containers derive theirs from their children.
export function minimumSizeOf(entry, measure) {
  if (entry.kind !== 'control') return { w: 0, h: 0 };
  const custom = customMinSizeOf(entry.node);
  const content = isContainerType(entry.type)
    ? containerMinSize(entry, measure)
    : (measure ? measure(entry) : { w: 0, h: 0 }) || { w: 0, h: 0 };
  return { w: Math.max(custom.x, content.w || 0), h: Math.max(custom.y, content.h || 0) };
}

function containerMinSize(entry, measure) {
  const kids = laidOutChildren(entry);
  const mins = kids.map((c) => minimumSizeOf(c, measure));
  const maxW = () => mins.reduce((m, s) => Math.max(m, s.w), 0);
  const maxH = () => mins.reduce((m, s) => Math.max(m, s.h), 0);
  const sumW = () => mins.reduce((m, s) => m + s.w, 0);
  const sumH = () => mins.reduce((m, s) => m + s.h, 0);
  const gap = (n, sep) => Math.max(0, n - 1) * sep;

  switch (entry.type) {
    case 'BoxContainer': case 'HBoxContainer': case 'VBoxContainer':
    case 'FlowContainer': case 'HFlowContainer': case 'VFlowContainer': {
      const sep = constantOf(entry.node, 'separation', THEME.boxSeparation);
      return isVerticalBox(entry) || entry.type === 'VFlowContainer'
        ? { w: maxW(), h: sumH() + gap(kids.length, sep) }
        : { w: sumW() + gap(kids.length, sep), h: maxH() };
    }
    case 'GridContainer': {
      const cols = Math.max(1, num(entry.node, 'columns', 1));
      const hs = constantOf(entry.node, 'h_separation', THEME.gridHSeparation);
      const vs = constantOf(entry.node, 'v_separation', THEME.gridVSeparation);
      const colW = [], rowH = [];
      mins.forEach((s, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        colW[c] = Math.max(colW[c] || 0, s.w);
        rowH[r] = Math.max(rowH[r] || 0, s.h);
      });
      return {
        w: colW.reduce((a, b) => a + b, 0) + gap(colW.length, hs),
        h: rowH.reduce((a, b) => a + b, 0) + gap(rowH.length, vs),
      };
    }
    case 'MarginContainer': {
      const m = marginsOf(entry.node);
      return { w: maxW() + m.left + m.right, h: maxH() + m.top + m.bottom };
    }
    case 'PanelContainer': {
      const m = THEME.panelMargin;
      return { w: maxW() + m * 2, h: maxH() + m * 2 };
    }
    case 'CenterContainer': case 'AspectRatioContainer':
      return { w: maxW(), h: maxH() };
    case 'ScrollContainer':
      return { w: 0, h: 0 }; // a scroll view can shrink below its content
    case 'SplitContainer': case 'HSplitContainer': case 'VSplitContainer': {
      const sep = constantOf(entry.node, 'separation', THEME.splitSeparation);
      return isVerticalSplit(entry)
        ? { w: maxW(), h: sumH() + gap(kids.length, sep) }
        : { w: sumW() + gap(kids.length, sep), h: maxH() };
    }
    case 'TabContainer':
      return { w: maxW(), h: maxH() + THEME.tabBarHeight };
    default:
      return { w: maxW(), h: maxH() };
  }
}

function marginsOf(node) {
  return {
    left: constantOf(node, 'margin_left', 0),
    top: constantOf(node, 'margin_top', 0),
    right: constantOf(node, 'margin_right', 0),
    bottom: constantOf(node, 'margin_bottom', 0),
  };
}

// --- placement --------------------------------------------------------------

// One axis of a box container: hand each child its minimum, then share the
// leftover between the EXPAND children in proportion to their stretch ratios.
function distribute(total, mins, flags, sep) {
  const n = mins.length;
  if (!n) return [];
  const used = mins.reduce((a, b) => a + b, 0) + Math.max(0, n - 1) * sep;
  const sizes = mins.slice();
  const spare = total - used;
  const expanders = flags.map((f, i) => (f.flag & SIZE_EXPAND ? i : -1)).filter((i) => i >= 0);
  if (spare > 0 && expanders.length) {
    const ratioSum = expanders.reduce((a, i) => a + (flags[i].ratio || 1), 0) || 1;
    for (const i of expanders) sizes[i] += spare * ((flags[i].ratio || 1) / ratioSum);
  } else if (spare < 0) {
    // Shrink everyone proportionally rather than letting children overflow.
    const scale = used > 0 ? Math.max(0, total - Math.max(0, n - 1) * sep) / Math.max(1e-6, used - Math.max(0, n - 1) * sep) : 0;
    for (let i = 0; i < n; i++) sizes[i] = mins[i] * scale;
  }
  return sizes;
}

// Place one child across the container's cross axis according to its size flag.
function crossPlace(flag, avail, min) {
  if (flag & SIZE_FILL) return { pos: 0, size: avail };
  const size = Math.min(min, avail);
  if (flag & SIZE_SHRINK_END) return { pos: avail - size, size };
  if (flag & SIZE_SHRINK_CENTER) return { pos: (avail - size) / 2, size };
  return { pos: 0, size };
}

// Rects (container-local) for every laid-out child, keyed by array index.
function layoutContainer(entry, size, mins) {
  const kids = laidOutChildren(entry);
  const flagsOf = (c) => {
    const f = sizeFlagsOf(c.node);
    return { h: f.h, v: f.v, ratio: f.stretchRatio };
  };
  const out = kids.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  if (!kids.length) return { kids, rects: out };

  switch (entry.type) {
    case 'BoxContainer': case 'HBoxContainer': case 'VBoxContainer':
    case 'FlowContainer': case 'HFlowContainer': case 'VFlowContainer': {
      const vertical = isVerticalBox(entry) || entry.type === 'VFlowContainer';
      const sep = constantOf(entry.node, 'separation', THEME.boxSeparation);
      const main = vertical ? size.h : size.w;
      const cross = vertical ? size.w : size.h;
      const flags = kids.map((c) => { const f = flagsOf(c); return { flag: vertical ? f.v : f.h, ratio: f.ratio }; });
      const sizes = distribute(main, mins.map((m) => (vertical ? m.h : m.w)), flags, sep);
      let at = 0;
      kids.forEach((c, i) => {
        const f = flagsOf(c);
        const cp = crossPlace(vertical ? f.h : f.v, cross, vertical ? mins[i].w : mins[i].h);
        out[i] = vertical
          ? { x: cp.pos, y: at, w: cp.size, h: sizes[i] }
          : { x: at, y: cp.pos, w: sizes[i], h: cp.size };
        at += sizes[i] + sep;
      });
      return { kids, rects: out };
    }
    case 'GridContainer': {
      const cols = Math.max(1, num(entry.node, 'columns', 1));
      const hs = constantOf(entry.node, 'h_separation', THEME.gridHSeparation);
      const vs = constantOf(entry.node, 'v_separation', THEME.gridVSeparation);
      const colW = [], rowH = [], colExp = [], rowExp = [];
      kids.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols), f = flagsOf(c);
        colW[col] = Math.max(colW[col] || 0, mins[i].w);
        rowH[row] = Math.max(rowH[row] || 0, mins[i].h);
        colExp[col] = colExp[col] || !!(f.h & SIZE_EXPAND);
        rowExp[row] = rowExp[row] || !!(f.v & SIZE_EXPAND);
      });
      const share = (sizes, expanded, total, sep) => {
        const used = sizes.reduce((a, b) => a + b, 0) + Math.max(0, sizes.length - 1) * sep;
        const idx = expanded.map((e, i) => (e ? i : -1)).filter((i) => i >= 0);
        const spare = total - used;
        if (spare > 0 && idx.length) for (const i of idx) sizes[i] += spare / idx.length;
        return sizes;
      };
      share(colW, colExp, size.w, hs);
      share(rowH, rowExp, size.h, vs);
      const colX = [], rowY = [];
      colW.reduce((a, w, i) => { colX[i] = a; return a + w + hs; }, 0);
      rowH.reduce((a, h, i) => { rowY[i] = a; return a + h + vs; }, 0);
      kids.forEach((c, i) => {
        const col = i % cols, row = Math.floor(i / cols), f = flagsOf(c);
        const cx = crossPlace(f.h, colW[col], mins[i].w);
        const cy = crossPlace(f.v, rowH[row], mins[i].h);
        out[i] = { x: colX[col] + cx.pos, y: rowY[row] + cy.pos, w: cx.size, h: cy.size };
      });
      return { kids, rects: out };
    }
    case 'CenterContainer': {
      kids.forEach((c, i) => {
        out[i] = { x: (size.w - mins[i].w) / 2, y: (size.h - mins[i].h) / 2, w: mins[i].w, h: mins[i].h };
      });
      return { kids, rects: out };
    }
    case 'MarginContainer': {
      const m = marginsOf(entry.node);
      kids.forEach((c, i) => {
        out[i] = { x: m.left, y: m.top, w: size.w - m.left - m.right, h: size.h - m.top - m.bottom };
      });
      return { kids, rects: out };
    }
    case 'PanelContainer': {
      const m = THEME.panelMargin;
      kids.forEach((c, i) => { out[i] = { x: m, y: m, w: size.w - m * 2, h: size.h - m * 2 }; });
      return { kids, rects: out };
    }
    case 'AspectRatioContainer': {
      const ratio = num(entry.node, 'ratio', 1) || 1;
      const mode = num(entry.node, 'stretch_mode', 2); // 2 = FIT
      const alignH = num(entry.node, 'alignment_horizontal', 1); // 1 = center
      const alignV = num(entry.node, 'alignment_vertical', 1);
      let w = size.w, h = size.h;
      if (mode === 0) h = w / ratio;             // WIDTH_CONTROLS_HEIGHT
      else if (mode === 1) w = h * ratio;        // HEIGHT_CONTROLS_WIDTH
      else if (mode === 3) {                      // COVER
        if (size.w / size.h < ratio) w = h * ratio; else h = w / ratio;
      } else if (size.w / size.h > ratio) w = h * ratio; else h = w / ratio; // FIT
      const place = (align, avail, s) => (align === 0 ? 0 : align === 2 ? avail - s : (avail - s) / 2);
      kids.forEach((c, i) => {
        out[i] = { x: place(alignH, size.w, w), y: place(alignV, size.h, h), w, h };
      });
      return { kids, rects: out };
    }
    case 'ScrollContainer': {
      // Children keep their minimum along a scrollable axis and fill the other.
      const hMode = num(entry.node, 'horizontal_scroll_mode', 1);
      const vMode = num(entry.node, 'vertical_scroll_mode', 1);
      kids.forEach((c, i) => {
        out[i] = {
          x: 0, y: 0,
          w: hMode === 0 ? size.w : Math.max(size.w, mins[i].w),
          h: vMode === 0 ? size.h : Math.max(size.h, mins[i].h),
        };
      });
      return { kids, rects: out };
    }
    case 'SplitContainer': case 'HSplitContainer': case 'VSplitContainer': {
      const vertical = isVerticalSplit(entry);
      const sep = constantOf(entry.node, 'separation', THEME.splitSeparation);
      const offset = num(entry.node, 'split_offset', 0);
      const main = vertical ? size.h : size.w;
      const cross = vertical ? size.w : size.h;
      if (kids.length === 1) {
        out[0] = { x: 0, y: 0, w: size.w, h: size.h };
        return { kids, rects: out };
      }
      const firstMin = vertical ? mins[0].h : mins[0].w;
      const secondMin = vertical ? mins[1].h : mins[1].w;
      const usable = Math.max(0, main - sep);
      const first = Math.min(Math.max((usable) / 2 + offset, firstMin), Math.max(firstMin, usable - secondMin));
      const second = usable - first;
      out[0] = vertical ? { x: 0, y: 0, w: cross, h: first } : { x: 0, y: 0, w: first, h: cross };
      out[1] = vertical
        ? { x: 0, y: first + sep, w: cross, h: second }
        : { x: first + sep, y: 0, w: second, h: cross };
      // Godot only lays out the first two children of a split container.
      for (let i = 2; i < kids.length; i++) out[i] = { x: 0, y: 0, w: size.w, h: size.h };
      return { kids, rects: out };
    }
    case 'TabContainer': {
      const bar = THEME.tabBarHeight;
      kids.forEach((c, i) => { out[i] = { x: 0, y: bar, w: size.w, h: Math.max(0, size.h - bar) }; });
      return { kids, rects: out };
    }
    default:
      kids.forEach((c, i) => { out[i] = { x: 0, y: 0, w: size.w, h: size.h }; });
      return { kids, rects: out };
  }
}

// Anchored placement for a child of a non-container, clamped to its minimum
// size the way Godot does (grow_direction picks which edge moves).
function anchoredRect(entry, parentSize, min) {
  const anchors = anchorsOf(entry.node);
  const offsets = offsetsOf(entry.node);
  const r = rectOf(anchors, offsets, parentSize);
  const grow = growDirsOf(entry.node);
  const fix = (pos, size, minSize, dir) => {
    if (size >= minSize) return { pos, size };
    const extra = minSize - size;
    if (dir === 0) return { pos: pos - extra, size: minSize };        // BEGIN
    if (dir === 1) return { pos, size: minSize };                      // END
    return { pos: pos - extra / 2, size: minSize };                    // BOTH
  };
  const h = fix(r.x, r.w, min.w, grow.h);
  const v = fix(r.y, r.h, min.h, grow.v);
  return { x: h.pos, y: v.pos, w: h.size, h: v.size };
}

// Node2D children position themselves with a plain `position` and carry no size.
function node2dOffset(entry) {
  const v = parseNums(getProp(entry.node, 'position') ?? '');
  return v.length >= 2 ? { x: v[0], y: v[1] } : { x: 0, y: 0 };
}

const intersect = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
};

// Absolute rects for every node, in document order. `measure` reports a node's
// content minimum size (text/texture) and may be omitted for a rough layout.
export function layoutScene(doc, { viewportSize, measure } = {}) {
  const root = buildControlTree(doc);
  const layout = new Map();
  if (!root) return layout;
  const view = { w: viewportSize?.width ?? viewportSize?.w ?? 1152, h: viewportSize?.height ?? viewportSize?.h ?? 648 };
  let order = 0;

  const walk = (entry, parentOrigin, parentSize, parentVisible, clipRect, managedRect, depth) => {
    const visible = parentVisible && visibleOf(entry.node);
    const min = minimumSizeOf(entry, measure);
    let local;
    if (entry.kind === 'control') {
      local = managedRect || anchoredRect(entry, parentSize, min);
    } else if (entry.kind === 'node2d') {
      const p = node2dOffset(entry);
      local = { x: p.x, y: p.y, w: 0, h: 0 };
    } else {
      // CanvasLayer / plain Node: no rect of its own, children anchor against
      // the same box it was handed.
      local = { x: 0, y: 0, w: parentSize.w, h: parentSize.h };
    }
    const rect = { x: parentOrigin.x + local.x, y: parentOrigin.y + local.y, w: local.w, h: local.h };
    const clip = entry.kind === 'control'
      && (getProp(entry.node, 'clip_contents') === 'true' || entry.type === 'ScrollContainer');
    const childClip = clip ? intersect(clipRect, rect) : clipRect;

    layout.set(entry.path, {
      path: entry.path,
      type: entry.type,
      kind: entry.kind,
      rect,
      local,
      parentSize: { w: parentSize.w, h: parentSize.h },
      minSize: min,
      anchors: entry.kind === 'control' ? anchorsOf(entry.node) : [0, 0, 0, 0],
      managed: !!managedRect,
      visible,
      clip,
      clipRect: childClip || null,
      depth,
      index: order++,
      rotation: entry.kind === 'other' ? 0 : rotationOf(entry.node),
      scale: entry.kind === 'other' ? { x: 1, y: 1 } : scaleOf(entry.node),
      pivot: entry.kind === 'control' ? pivotOf(entry.node) : { x: 0, y: 0 },
      entry,
    });

    const childSize = entry.kind === 'control' ? { w: rect.w, h: rect.h } : parentSize;
    const childOrigin = entry.kind === 'other' ? parentOrigin : { x: rect.x, y: rect.y };
    let managedFor = null;
    if (entry.kind === 'control' && isContainerType(entry.type)) {
      const kids = laidOutChildren(entry);
      const mins = kids.map((c) => minimumSizeOf(c, measure));
      const placed = layoutContainer(entry, childSize, mins);
      managedFor = new Map();
      placed.kids.forEach((c, i) => managedFor.set(c.path, placed.rects[i]));
      // TabContainer shows only the current tab.
      if (entry.type === 'TabContainer') {
        const current = num(entry.node, 'current_tab', 0);
        placed.kids.forEach((c, i) => { if (i !== current) managedFor.delete(c.path); });
      }
    }
    for (const child of entry.children) {
      const mr = managedFor ? managedFor.get(child.path) : null;
      const hidden = managedFor && !mr && child.kind === 'control' && visibleOf(child.node)
        && entry.type === 'TabContainer';
      walk(child, childOrigin, childSize, visible && !hidden, childClip, mr || null, depth + 1);
    }
  };

  walk(root, { x: 0, y: 0 }, view, true, null, null, 0);
  return layout;
}

// --- picking / snapping -----------------------------------------------------

const contains = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

// Topmost node under a point. Godot draws siblings in document order, so the
// last matching node in the map is the one on top.
export function pickAt(layout, x, y, { includeHidden = false } = {}) {
  let best = null;
  for (const info of layout.values()) {
    if (!includeHidden && !info.visible) continue;
    if (info.kind !== 'control') continue;
    if (info.rect.w <= 0 || info.rect.h <= 0) continue;
    if (!contains(info.rect, x, y)) continue;
    if (info.clipRect && !contains(info.clipRect, x, y)) continue;
    if (!best || info.index >= best.index) best = info;
  }
  return best ? best.path : null;
}

// Every node fully inside a marquee rectangle, shallowest first.
export function pickInRect(layout, rect) {
  const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
  const out = [];
  for (const info of layout.values()) {
    if (!info.visible || info.kind !== 'control') continue;
    const r = info.rect;
    if (r.x >= rect.x && r.y >= rect.y && r.x + r.w <= x2 && r.y + r.h <= y2) out.push(info);
  }
  return out.sort((a, b) => a.depth - b.depth || a.index - b.index).map((i) => i.path);
}

// Candidate snap lines: every edge and centre of the nodes not being dragged,
// plus the viewport frame.
export function snapTargets(layout, movingPaths, viewportSize) {
  const moving = new Set(movingPaths || []);
  const xs = new Set(), ys = new Set();
  if (viewportSize) {
    xs.add(0); xs.add(viewportSize.width ?? viewportSize.w); xs.add((viewportSize.width ?? viewportSize.w) / 2);
    ys.add(0); ys.add(viewportSize.height ?? viewportSize.h); ys.add((viewportSize.height ?? viewportSize.h) / 2);
  }
  for (const info of layout.values()) {
    if (!info.visible || info.kind !== 'control' || moving.has(info.path)) continue;
    const r = info.rect;
    xs.add(r.x); xs.add(r.x + r.w); xs.add(r.x + r.w / 2);
    ys.add(r.y); ys.add(r.y + r.h); ys.add(r.y + r.h / 2);
  }
  return { xs: [...xs], ys: [...ys] };
}

// Nudge a rect onto the nearest snap line within `tol`, keeping its size.
// Returns the adjusted rect plus the lines that were hit, for drawing guides.
export function snapRect(rect, targets, tol = 6) {
  const guides = { xs: [], ys: [] };
  const best = (values, candidates) => {
    let hit = null, dist = tol;
    for (const v of values) {
      for (const c of candidates) {
        const d = Math.abs(v - c);
        if (d < dist) { dist = d; hit = { delta: c - v, line: c }; }
      }
    }
    return hit;
  };
  const hx = best([rect.x, rect.x + rect.w, rect.x + rect.w / 2], targets.xs);
  const hy = best([rect.y, rect.y + rect.h, rect.y + rect.h / 2], targets.ys);
  const out = { ...rect };
  if (hx) { out.x += hx.delta; guides.xs.push(hx.line); }
  if (hy) { out.y += hy.delta; guides.ys.push(hy.line); }
  return { rect: out, guides };
}
