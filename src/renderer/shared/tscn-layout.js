import { getProp, setProp, removeProp, findNode, parseNums, fmtNum } from './tscn.js';

// Godot Control layout math: a control's rect is derived from four anchors
// (fractions of the parent's size) plus four offsets (pixels from the anchored
// point). Everything here is pure arithmetic over a parsed .tscn document, so
// the canvas can stay a thin painter over it.
//
//   x = anchor_left  * parentW + offset_left
//   y = anchor_top   * parentH + offset_top
//   w = anchor_right * parentW + offset_right - x
//   h = anchor_bottom* parentH + offset_bottom - y

// Godot's LayoutPreset enum, in enum order: [left, top, right, bottom] anchors.
export const ANCHOR_PRESETS = [
  { id: 0, name: 'Top Left', anchors: [0, 0, 0, 0] },
  { id: 1, name: 'Top Right', anchors: [1, 0, 1, 0] },
  { id: 2, name: 'Bottom Left', anchors: [0, 1, 0, 1] },
  { id: 3, name: 'Bottom Right', anchors: [1, 1, 1, 1] },
  { id: 4, name: 'Center Left', anchors: [0, 0.5, 0, 0.5] },
  { id: 5, name: 'Center Top', anchors: [0.5, 0, 0.5, 0] },
  { id: 6, name: 'Center Right', anchors: [1, 0.5, 1, 0.5] },
  { id: 7, name: 'Center Bottom', anchors: [0.5, 1, 0.5, 1] },
  { id: 8, name: 'Center', anchors: [0.5, 0.5, 0.5, 0.5] },
  { id: 9, name: 'Left Wide', anchors: [0, 0, 0, 1] },
  { id: 10, name: 'Top Wide', anchors: [0, 0, 1, 0] },
  { id: 11, name: 'Right Wide', anchors: [1, 0, 1, 1] },
  { id: 12, name: 'Bottom Wide', anchors: [0, 1, 1, 1] },
  { id: 13, name: 'VCenter Wide', anchors: [0.5, 0, 0.5, 1] },
  { id: 14, name: 'HCenter Wide', anchors: [0, 0.5, 1, 0.5] },
  { id: 15, name: 'Full Rect', anchors: [0, 0, 1, 1] },
];

const ANCHOR_KEYS = ['anchor_left', 'anchor_top', 'anchor_right', 'anchor_bottom'];
const OFFSET_KEYS = ['offset_left', 'offset_top', 'offset_right', 'offset_bottom'];

function num(node, key, def) {
  const raw = getProp(node, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function anchorsOf(node) { return ANCHOR_KEYS.map((k) => num(node, k, 0)); }
export function offsetsOf(node) { return OFFSET_KEYS.map((k) => num(node, k, 0)); }

export function rectOf(anchors, offsets, parentSize) {
  const pw = parentSize.w ?? parentSize.width ?? 0;
  const ph = parentSize.h ?? parentSize.height ?? 0;
  const x = anchors[0] * pw + offsets[0];
  const y = anchors[1] * ph + offsets[1];
  return { x, y, w: anchors[2] * pw + offsets[2] - x, h: anchors[3] * ph + offsets[3] - y };
}

// The exact inverse of rectOf: the offsets that put `rect` where it is under
// the given anchors.
export function offsetsForRect(rect, anchors, parentSize) {
  const pw = parentSize.w ?? parentSize.width ?? 0;
  const ph = parentSize.h ?? parentSize.height ?? 0;
  return [
    rect.x - anchors[0] * pw,
    rect.y - anchors[1] * ph,
    rect.x + rect.w - anchors[2] * pw,
    rect.y + rect.h - anchors[3] * ph,
  ];
}

const near = (a, b) => Math.abs(a - b) < 1e-4;

// Which preset a control sits at, or null when its anchors match no preset.
// Only the anchors decide — Godot's preset buttons set anchors, and a preset
// with shifted offsets is still that preset.
export function presetIdOf(anchors) {
  const p = ANCHOR_PRESETS.find((x) => x.anchors.every((a, i) => near(a, anchors[i])));
  return p ? p.id : null;
}

// Apply a preset. `keepRect` (Godot's "anchors only" mode) recomputes the
// offsets so the control does not visually move; otherwise the control snaps
// into the preset's region — keeping its size for point presets, stretching to
// fill for wide ones, exactly as Godot's "anchors and offsets" does.
export function applyPreset(presetId, rect, parentSize, { keepRect = false } = {}) {
  const preset = ANCHOR_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown layout preset: ${presetId}`);
  const anchors = preset.anchors.slice();
  if (keepRect) return { anchors, offsets: offsetsForRect(rect, anchors, parentSize) };
  const axis = (a0, a1, size) => (near(a0, a1) ? [-size * a0, size * (1 - a0)] : [0, 0]);
  const [l, r] = axis(anchors[0], anchors[2], rect.w);
  const [t, b] = axis(anchors[1], anchors[3], rect.h);
  return { anchors, offsets: [l, t, r, b] };
}

// grow_horizontal / grow_vertical: which edge moves when the minimum size
// forces a control wider than its offsets allow — 0 BEGIN, 1 END (Godot's
// default), 2 BOTH.
export function growDirsOf(node) {
  return { h: num(node, 'grow_horizontal', 1), v: num(node, 'grow_vertical', 1) };
}

// size_flags_* are bit flags: 1 FILL, 2 EXPAND, 4 SHRINK_CENTER, 8 SHRINK_END.
// Godot defaults both to FILL.
export const SIZE_FILL = 1, SIZE_EXPAND = 2, SIZE_SHRINK_CENTER = 4, SIZE_SHRINK_END = 8;
export function sizeFlagsOf(node) {
  return {
    h: num(node, 'size_flags_horizontal', SIZE_FILL),
    v: num(node, 'size_flags_vertical', SIZE_FILL),
    stretchRatio: num(node, 'size_flags_stretch_ratio', 1),
  };
}

function vec2(node, key, dx, dy) {
  const v = parseNums(getProp(node, key) ?? '');
  return v.length >= 2 ? { x: v[0], y: v[1] } : { x: dx, y: dy };
}

export function customMinSizeOf(node) { return vec2(node, 'custom_minimum_size', 0, 0); }
export function pivotOf(node) { return vec2(node, 'pivot_offset', 0, 0); }
export function scaleOf(node) { return vec2(node, 'scale', 1, 1); }
export function rotationOf(node) { return num(node, 'rotation', 0); }
export function visibleOf(node) { return getProp(node, 'visible') !== 'false'; }

// --- writers ---------------------------------------------------------------
// Godot omits any property still at its default, so writing a default REMOVES
// the line. Everything the edit does not touch keeps its original raw string.

function writeNums(node, keys, values, def) {
  for (let i = 0; i < keys.length; i++) {
    if (near(values[i], def)) removeProp(node, keys[i]);
    else setProp(node, keys[i], fmtNum(values[i]));
  }
}

export function writeAnchors(node, anchors) {
  writeNums(node, ANCHOR_KEYS, anchors, 0);
  const preset = presetIdOf(anchors);
  // `anchors_preset` is editor bookkeeping; -1 marks a custom anchor set.
  if (preset === 0) removeProp(node, 'anchors_preset');
  else setProp(node, 'anchors_preset', String(preset === null ? -1 : preset));
}

// Write a control's placement. `containerChild` marks a node whose parent lays
// it out: anchors/offsets are meaningless there, so only `layout_mode = 2` is
// recorded and the rect is left to the container.
export function writeRect(doc, path, { anchors, offsets, containerChild = false }) {
  const node = findNode(doc, path);
  if (!node) throw new Error(`node not found: ${path}`);
  if (containerChild) { setProp(node, 'layout_mode', '2'); return; }
  writeAnchors(node, anchors);
  writeNums(node, OFFSET_KEYS, offsets, 0);
  if (getProp(node, 'layout_mode') === '2') removeProp(node, 'layout_mode');
}
