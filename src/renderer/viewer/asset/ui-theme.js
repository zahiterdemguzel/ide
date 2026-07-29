import { getProp, attrStr, parseNums, parseRef, unquote } from '../../shared/tscn.js';

// An approximation of Godot 4's default UI theme, plus the parts of the theme
// system a scene file can carry inline: `theme_override_*` properties and
// StyleBox sub-resources. Real `.theme`/`.tres` resources are not loaded — the
// preview aims to look like the game, not to be pixel-exact.

export const FONT_STACK = "'Segoe UI', system-ui, -apple-system, sans-serif";
export const DEFAULT_FONT_SIZE = 16;

// Godot's Color(r, g, b, a) is float 0..1; a missing alpha means opaque.
export function colorOf(raw, fallback = null) {
  if (raw === undefined || raw === null) return fallback;
  const n = parseNums(raw);
  if (n.length < 3) return fallback;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const a = n.length >= 4 ? Math.max(0, Math.min(1, n[3])) : 1;
  return `rgba(${c(n[0])}, ${c(n[1])}, ${c(n[2])}, ${Number(a.toFixed(4))})`;
}

// A StyleBox as the painter needs it: fill, per-side borders, per-corner radii.
const box = (o = {}) => ({
  fill: null, border: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0],
  contentMargin: [0, 0, 0, 0], drawCenter: true, ...o,
});

const GREY = (v, a = 1) => `rgba(${v}, ${v}, ${v + 4}, ${a})`;

// The default-theme styleboxes the editor draws, per control type and state.
const DEFAULT_STYLES = {
  Panel: box({ fill: 'rgba(25, 25, 29, 0.85)', radius: [3, 3, 3, 3] }),
  PanelContainer: box({ fill: 'rgba(25, 25, 29, 0.85)', radius: [3, 3, 3, 3] }),
  Button: box({ fill: GREY(42), border: GREY(60), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [8, 4, 8, 4] }),
  OptionButton: box({ fill: GREY(42), border: GREY(60), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [8, 4, 24, 4] }),
  MenuButton: box({ fill: GREY(42), border: GREY(60), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [8, 4, 8, 4] }),
  LineEdit: box({ fill: GREY(24), border: GREY(56), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [6, 4, 6, 4] }),
  TextEdit: box({ fill: GREY(24), border: GREY(56), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [6, 4, 6, 4] }),
  CodeEdit: box({ fill: GREY(24), border: GREY(56), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [6, 4, 6, 4] }),
  SpinBox: box({ fill: GREY(24), border: GREY(56), borderWidth: [1, 1, 1, 1], radius: [3, 3, 3, 3], contentMargin: [6, 4, 6, 4] }),
  ProgressBarBg: box({ fill: GREY(24), radius: [3, 3, 3, 3] }),
  ProgressBarFill: box({ fill: 'rgba(60, 137, 199, 1)', radius: [3, 3, 3, 3] }),
  SliderTrack: box({ fill: GREY(24), radius: [2, 2, 2, 2] }),
  SliderGrabber: box({ fill: 'rgba(110, 175, 230, 1)', radius: [8, 8, 8, 8] }),
  TabBar: box({ fill: GREY(32), radius: [3, 3, 0, 0] }),
  TabActive: box({ fill: GREY(48), radius: [3, 3, 0, 0] }),
  ScrollBar: box({ fill: GREY(60), radius: [3, 3, 3, 3] }),
  Separator: box({ fill: GREY(60) }),
  Splitter: box({ fill: GREY(56) }),
};

export const DEFAULT_FONT_COLOR = 'rgba(224, 224, 224, 1)';
export const DEFAULT_FONT_DISABLED = 'rgba(224, 224, 224, 0.4)';
export const DEFAULT_PLACEHOLDER_COLOR = 'rgba(224, 224, 224, 0.5)';
export const DEFAULT_ACCENT = 'rgba(110, 175, 230, 1)';

export function defaultStyleFor(name) { return DEFAULT_STYLES[name] || null; }

// --- inline resources -------------------------------------------------------

function subResourceOf(doc, raw) {
  const ref = raw === undefined ? null : parseRef(raw);
  if (!ref || ref.kind !== 'sub') return null;
  return doc.sections.find((s) => s.tag === 'sub_resource' && attrStr(s, 'id') === ref.id) || null;
}

export function extResourceOf(doc, raw) {
  const ref = raw === undefined ? null : parseRef(raw);
  if (!ref || ref.kind !== 'ext') return null;
  return doc.sections.find((s) => s.tag === 'ext_resource' && attrStr(s, 'id') === ref.id) || null;
}

// The res:// path a texture-ish property points at, or null.
export function texturePathOf(doc, raw) {
  const ext = extResourceOf(doc, raw);
  const path = ext && attrStr(ext, 'path');
  return path && path.startsWith('res://') ? path : null;
}

const sideNums = (sec, prefix, def) => ['left', 'top', 'right', 'bottom']
  .map((s) => { const n = Number(getProp(sec, `${prefix}_${s}`)); return Number.isFinite(n) ? n : def; });
const cornerNums = (sec, def) => ['top_left', 'top_right', 'bottom_right', 'bottom_left']
  .map((s) => { const n = Number(getProp(sec, `corner_radius_${s}`)); return Number.isFinite(n) ? n : def; });

// A `SubResource("StyleBoxFlat_x")` reference resolved into a paintable box.
// StyleBoxEmpty draws nothing; StyleBoxTexture and StyleBoxLine fall back to a
// flat approximation, which is enough to keep the layout readable.
export function styleBoxOf(doc, raw, fallback = null) {
  const sec = subResourceOf(doc, raw);
  if (!sec) return fallback;
  const type = attrStr(sec, 'type');
  const contentMargin = sideNums(sec, 'content_margin', 0);
  if (type === 'StyleBoxEmpty') return box({ fill: null, contentMargin });
  if (type === 'StyleBoxFlat') {
    return box({
      fill: colorOf(getProp(sec, 'bg_color'), 'rgba(25, 25, 29, 0.85)'),
      border: colorOf(getProp(sec, 'border_color'), 'rgba(0, 0, 0, 0.8)'),
      borderWidth: sideNums(sec, 'border_width', 0),
      radius: cornerNums(sec, 0),
      drawCenter: getProp(sec, 'draw_center') !== 'false',
      contentMargin,
    });
  }
  if (type === 'StyleBoxLine') {
    return box({ fill: colorOf(getProp(sec, 'color'), 'rgba(120, 120, 128, 1)'), contentMargin });
  }
  return box({ fill: 'rgba(60, 60, 68, 0.6)', contentMargin });
}

// theme_override_* buckets for a node, as plain maps keyed by the name after
// the slash (`theme_override_colors/font_color` → colors.font_color).
export function themeOverridesOf(node) {
  const out = { colors: {}, fonts: {}, font_sizes: {}, constants: {}, styles: {} };
  for (const p of node.props) {
    const m = /^theme_override_(colors|fonts|font_sizes|constants|styles)\/(.+)$/.exec(p.key);
    if (m) out[m[1]][m[2]] = p.value;
  }
  return out;
}

// The font colour a control paints text in: its override, else the default.
export function fontColorOf(node, fallback = DEFAULT_FONT_COLOR) {
  return colorOf(getProp(node, 'theme_override_colors/font_color'), fallback);
}

export function fontSizeOf(node, fallback = DEFAULT_FONT_SIZE) {
  const n = Number(getProp(node, 'theme_override_font_sizes/font_size'));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The stylebox a control actually paints, preferring an inline override.
export function styleFor(doc, node, overrideName, defaultName) {
  const raw = getProp(node, `theme_override_styles/${overrideName}`);
  return styleBoxOf(doc, raw, defaultStyleFor(defaultName));
}

// --- painting ---------------------------------------------------------------

function roundRectPath(ctx, x, y, w, h, radius) {
  const max = Math.min(w, h) / 2;
  const r = radius.map((v) => Math.max(0, Math.min(v, max)));
  ctx.beginPath();
  ctx.moveTo(x + r[0], y);
  ctx.lineTo(x + w - r[1], y);
  ctx.arcTo(x + w, y, x + w, y + r[1], r[1]);
  ctx.lineTo(x + w, y + h - r[2]);
  ctx.arcTo(x + w, y + h, x + w - r[2], y + h, r[2]);
  ctx.lineTo(x + r[3], y + h);
  ctx.arcTo(x, y + h, x, y + h - r[3], r[3]);
  ctx.lineTo(x, y + r[0]);
  ctx.arcTo(x, y, x + r[0], y, r[0]);
  ctx.closePath();
}

// Paint a stylebox into a rect. Borders are stroked as four inset rectangles so
// per-side widths work the way Godot's do (a uniform width strokes the outline).
export function drawStyleBox(ctx, style, rect) {
  if (!style || rect.w <= 0 || rect.h <= 0) return;
  const { x, y, w, h } = rect;
  const [bl, bt, br, bb] = style.borderWidth;
  const uniform = bl === bt && bt === br && br === bb;
  if (style.fill && style.drawCenter !== false) {
    roundRectPath(ctx, x, y, w, h, style.radius);
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (!style.border || (!bl && !bt && !br && !bb)) return;
  ctx.fillStyle = style.border;
  if (uniform) {
    ctx.save();
    roundRectPath(ctx, x, y, w, h, style.radius);
    ctx.clip();
    ctx.lineWidth = bl * 2; // clipped to the rounded outline, so half shows
    ctx.strokeStyle = style.border;
    roundRectPath(ctx, x, y, w, h, style.radius);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (bt) ctx.fillRect(x, y, w, bt);
  if (bb) ctx.fillRect(x, y + h - bb, w, bb);
  if (bl) ctx.fillRect(x, y, bl, h);
  if (br) ctx.fillRect(x + w - br, y, br, h);
}

// A string property's display text. Godot stores real newlines inside the
// quotes, so unquoting (which undoes the " and \ escapes) is all that's needed.
export function textOf(node, key = 'text') {
  const raw = getProp(node, key);
  return raw === undefined ? '' : unquote(raw);
}
