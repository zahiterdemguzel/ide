import { getProp, parseNums } from '../../shared/tscn.js';
import {
  FONT_STACK, DEFAULT_FONT_COLOR, DEFAULT_FONT_DISABLED,
  DEFAULT_PLACEHOLDER_COLOR, DEFAULT_ACCENT,
  colorOf, defaultStyleFor, styleFor, drawStyleBox, fontColorOf, fontSizeOf,
  texturePathOf, textOf,
} from './ui-theme.js';

// The widget painter: one `draw` per Control type, plus the `measure` callback
// the layout engine needs (only the painter knows how wide a string is). Both
// halves share the same font/stylebox rules so a control's minimum size matches
// what actually gets drawn.

const num = (node, key, def) => { const n = Number(getProp(node, key)); return Number.isFinite(n) ? n : def; };
const bool = (node, key, def) => { const v = getProp(node, key); return v === undefined ? def : v === 'true'; };

const fontOf = (node, size) => `${size || fontSizeOf(node)}px ${FONT_STACK}`;

// Godot's BBCode is not interpreted; tags are stripped so the text still reads.
const stripBBCode = (s) => s.replace(/\[\/?[a-zA-Z][^\]]*\]/g, '');

// Greedy word wrap, falling back to character breaks for a single long word.
export function wrapText(ctx, text, maxWidth) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (line && ctx.measureText(next).width > maxWidth) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

// Godot's HorizontalAlignment / VerticalAlignment: 0 begin, 1 center, 2 end, 3 fill.
const alignX = (align, x, w, textW) => (align === 1 ? x + (w - textW) / 2 : align === 2 ? x + w - textW : x);
const alignY = (align, y, h, textH) => (align === 1 ? y + (h - textH) / 2 : align === 2 ? y + h - textH : y);

// Types drawn as a plain labelled outline: no visual of their own, or one the
// preview does not model. They still select, move and inspect normally.
const OUTLINE_ONLY = new Set([
  'Control', 'Container', 'BoxContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'MarginContainer', 'AspectRatioContainer', 'FlowContainer',
  'HFlowContainer', 'VFlowContainer', 'SplitContainer', 'HSplitContainer', 'VSplitContainer',
  'ScrollContainer', 'ReferenceRect', 'SubViewportContainer', 'GraphEdit',
]);

export function createPainter({ doc, measureCtx, textureFor }) {
  const setDoc = (d) => { doc = d; };
  const image = (node, key) => {
    const res = texturePathOf(doc, getProp(node, key));
    return res ? textureFor(res) : null;
  };

  // --- measurement (content minimum size) ---
  const measure = (entry) => {
    const node = entry.node;
    const type = entry.type;
    const ctx = measureCtx;
    const size = fontSizeOf(node);
    ctx.font = fontOf(node, size);
    const lineH = Math.round(size * 1.35);
    const textWidth = (s) => ctx.measureText(s).width;

    switch (type) {
      case 'Label': {
        const lines = textOf(node).split('\n');
        return { w: Math.max(0, ...lines.map(textWidth)), h: lineH * lines.length };
      }
      case 'RichTextLabel':
        return bool(node, 'fit_content', false)
          ? { w: 0, h: lineH * Math.max(1, stripBBCode(textOf(node)).split('\n').length) }
          : { w: 0, h: 0 };
      case 'Button': case 'CheckBox': case 'CheckButton': case 'OptionButton':
      case 'MenuButton': case 'LinkButton': {
        const style = defaultStyleFor(type) || defaultStyleFor('Button');
        const [ml, mt, mr, mb] = style.contentMargin;
        let w = textWidth(textOf(node));
        if (type === 'CheckBox' || type === 'CheckButton') w += 24;
        const icon = image(node, 'icon');
        if (icon) w += icon.naturalWidth + 4;
        return { w: w + ml + mr, h: Math.max(lineH, icon ? icon.naturalHeight : 0) + mt + mb };
      }
      case 'LineEdit': case 'SpinBox': {
        const style = defaultStyleFor('LineEdit');
        return { w: 60, h: lineH + style.contentMargin[1] + style.contentMargin[3] };
      }
      case 'TextEdit': case 'CodeEdit':
        return { w: 60, h: lineH * 3 };
      case 'TextureRect': case 'NinePatchRect': case 'Sprite2D': {
        const img = image(node, 'texture');
        // expand_mode IGNORE_SIZE (1) lets a TextureRect shrink below the image.
        if (!img || (type === 'TextureRect' && num(node, 'expand_mode', 0) !== 0)) return { w: 0, h: 0 };
        return { w: img.naturalWidth, h: img.naturalHeight };
      }
      case 'TextureButton': {
        const img = image(node, 'texture_normal');
        return img && !bool(node, 'ignore_texture_size', false)
          ? { w: img.naturalWidth, h: img.naturalHeight } : { w: 0, h: 0 };
      }
      case 'ProgressBar': return { w: 0, h: lineH + 4 };
      case 'HSlider': return { w: 0, h: 16 };
      case 'VSlider': return { w: 16, h: 0 };
      case 'HScrollBar': return { w: 0, h: 12 };
      case 'VScrollBar': return { w: 12, h: 0 };
      case 'HSeparator': return { w: 0, h: 4 };
      case 'VSeparator': return { w: 4, h: 0 };
      case 'ItemList': case 'Tree': return { w: 60, h: 60 };
      default: return { w: 0, h: 0 };
    }
  };

  // --- drawing ---
  const drawText = (ctx, node, text, rect, { hAlign = 0, vAlign = 1, color, size, wrap = false, clip = true } = {}) => {
    if (!text) return;
    const fs = size || fontSizeOf(node);
    ctx.font = fontOf(node, fs);
    ctx.fillStyle = color || fontColorOf(node);
    ctx.textBaseline = 'top';
    const lineH = Math.round(fs * 1.35);
    const lines = wrap ? wrapText(ctx, text, rect.w) : text.split('\n');
    const totalH = lineH * lines.length;
    let y = alignY(vAlign, rect.y, rect.h, totalH);
    for (const raw of lines) {
      const line = clip && !wrap ? ellipsize(ctx, raw, rect.w) : raw;
      ctx.fillText(line, alignX(hAlign, rect.x, rect.w, ctx.measureText(line).width), y);
      y += lineH;
    }
  };

  const inset = (rect, m) => ({ x: rect.x + m[0], y: rect.y + m[1], w: rect.w - m[0] - m[2], h: rect.h - m[1] - m[3] });

  const drawImage = (ctx, img, rect, stretch) => {
    if (!img || rect.w <= 0 || rect.h <= 0) return;
    const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    // Godot StretchMode: 0 scale, 1 tile, 2 keep, 3 keep_centered,
    // 4 keep_aspect, 5 keep_aspect_centered, 6 keep_aspect_covered.
    if (stretch === 2) ctx.drawImage(img, rect.x, rect.y, iw, ih);
    else if (stretch === 3) ctx.drawImage(img, rect.x + (rect.w - iw) / 2, rect.y + (rect.h - ih) / 2, iw, ih);
    else if (stretch === 4 || stretch === 5 || stretch === 6) {
      const cover = stretch === 6;
      const s = cover ? Math.max(rect.w / iw, rect.h / ih) : Math.min(rect.w / iw, rect.h / ih);
      const w = iw * s, h = ih * s;
      const cx = stretch === 4 ? rect.x : rect.x + (rect.w - w) / 2;
      const cy = stretch === 4 ? rect.y : rect.y + (rect.h - h) / 2;
      ctx.drawImage(img, cx, cy, w, h);
    } else if (stretch === 1) {
      for (let y = rect.y; y < rect.y + rect.h; y += ih) {
        for (let x = rect.x; x < rect.x + rect.w; x += iw) ctx.drawImage(img, x, y, iw, ih);
      }
    } else ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  };

  // Nine-patch: the texture split by patch margins, corners kept, edges and
  // centre stretched — the same decomposition NinePatchRect does.
  const drawNinePatch = (ctx, img, rect, m) => {
    if (!img) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const [ml, mt, mr, mb] = m;
    const sx = [0, ml, iw - mr, iw], sw = [ml, iw - ml - mr, mr];
    const sy = [0, mt, ih - mb, ih], sh = [mt, ih - mt - mb, mb];
    const dx = [rect.x, rect.x + ml, rect.x + rect.w - mr];
    const dw = [ml, Math.max(0, rect.w - ml - mr), mr];
    const dy = [rect.y, rect.y + mt, rect.y + rect.h - mb];
    const dh = [mt, Math.max(0, rect.h - mt - mb), mb];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (sw[c] <= 0 || sh[r] <= 0 || dw[c] <= 0 || dh[r] <= 0) continue;
        ctx.drawImage(img, sx[c], sy[r], sw[c], sh[r], dx[c], dy[r], dw[c], dh[r]);
      }
    }
  };

  const outline = (ctx, rect, label) => {
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 160, 190, 0.35)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
    ctx.restore();
    if (!label || rect.w < 40 || rect.h < 14) return;
    ctx.font = `11px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(140, 160, 190, 0.55)';
    ctx.textBaseline = 'top';
    ctx.fillText(label, rect.x + 3, rect.y + 2);
  };

  // Paint one node. `info` is the layout entry; the caller has already applied
  // pan/zoom (and any rotation/scale) to the context.
  const draw = (ctx, info) => {
    const { entry, rect } = info;
    const node = entry.node;
    const type = entry.type;
    const modulate = colorOf(getProp(node, 'modulate'), null);
    const self = colorOf(getProp(node, 'self_modulate'), null);
    ctx.save();
    if (modulate || self) {
      const alphaOf = (c) => { const n = parseNums(c ? getProp(node, c) : ''); return n.length >= 4 ? n[3] : 1; };
      ctx.globalAlpha *= alphaOf('modulate') * alphaOf('self_modulate');
    }

    switch (type) {
      case 'ColorRect': {
        ctx.fillStyle = colorOf(getProp(node, 'color'), 'rgba(255, 255, 255, 1)');
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        break;
      }
      case 'Panel': case 'PanelContainer':
        drawStyleBox(ctx, styleFor(doc, node, 'panel', type), rect);
        break;
      case 'TextureRect': case 'Sprite2D':
        drawImage(ctx, image(node, 'texture'), rect, num(node, 'stretch_mode', 0));
        if (!image(node, 'texture')) outline(ctx, rect, type);
        break;
      case 'NinePatchRect': {
        const img = image(node, 'texture');
        if (img) {
          drawNinePatch(ctx, img, rect, ['left', 'top', 'right', 'bottom'].map((s) => num(node, `patch_margin_${s}`, 0)));
        } else outline(ctx, rect, type);
        break;
      }
      case 'Label': {
        drawText(ctx, node, textOf(node), rect, {
          hAlign: num(node, 'horizontal_alignment', 0),
          vAlign: num(node, 'vertical_alignment', 0),
          wrap: num(node, 'autowrap_mode', 0) !== 0,
        });
        break;
      }
      case 'RichTextLabel':
        drawText(ctx, node, stripBBCode(textOf(node)), rect, { vAlign: 0, wrap: true });
        break;
      case 'Button': case 'OptionButton': case 'MenuButton': {
        const style = styleFor(doc, node, bool(node, 'disabled', false) ? 'disabled' : 'normal', type);
        if (!bool(node, 'flat', false)) drawStyleBox(ctx, style, rect);
        const inner = inset(rect, style.contentMargin);
        const icon = image(node, 'icon');
        let textRect = inner;
        if (icon) {
          const s = Math.min(icon.naturalHeight, inner.h);
          const iw = icon.naturalWidth * (s / Math.max(1, icon.naturalHeight));
          ctx.drawImage(icon, inner.x, inner.y + (inner.h - s) / 2, iw, s);
          textRect = { x: inner.x + iw + 4, y: inner.y, w: inner.w - iw - 4, h: inner.h };
        }
        drawText(ctx, node, textOf(node), textRect, {
          hAlign: num(node, 'alignment', 1),
          color: bool(node, 'disabled', false) ? DEFAULT_FONT_DISABLED : undefined,
        });
        if (type === 'OptionButton') {
          ctx.fillStyle = DEFAULT_FONT_COLOR;
          const cx = rect.x + rect.w - 14, cy = rect.y + rect.h / 2;
          ctx.beginPath();
          ctx.moveTo(cx - 4, cy - 2); ctx.lineTo(cx + 4, cy - 2); ctx.lineTo(cx, cy + 3);
          ctx.fill();
        }
        break;
      }
      case 'LinkButton':
        drawText(ctx, node, textOf(node), rect, { color: DEFAULT_ACCENT });
        break;
      case 'CheckBox': case 'CheckButton': {
        const on = bool(node, 'button_pressed', false);
        const boxSize = 16;
        const bx = rect.x + 4, by = rect.y + (rect.h - boxSize) / 2;
        drawStyleBox(ctx, { ...defaultStyleFor('LineEdit'), radius: type === 'CheckButton' ? [8, 8, 8, 8] : [3, 3, 3, 3] },
          { x: bx, y: by, w: type === 'CheckButton' ? boxSize * 1.6 : boxSize, h: boxSize });
        if (on) {
          ctx.fillStyle = DEFAULT_ACCENT;
          if (type === 'CheckButton') ctx.beginPath(), ctx.arc(bx + boxSize * 1.6 - 8, by + 8, 6, 0, Math.PI * 2), ctx.fill();
          else ctx.fillRect(bx + 4, by + 4, boxSize - 8, boxSize - 8);
        }
        const gap = (type === 'CheckButton' ? boxSize * 1.6 : boxSize) + 10;
        drawText(ctx, node, textOf(node), { x: rect.x + gap, y: rect.y, w: rect.w - gap, h: rect.h });
        break;
      }
      case 'LineEdit': case 'SpinBox': {
        const style = styleFor(doc, node, 'normal', 'LineEdit');
        drawStyleBox(ctx, style, rect);
        const inner = inset(rect, style.contentMargin);
        const text = textOf(node);
        drawText(ctx, node, text || textOf(node, 'placeholder_text'), inner, {
          hAlign: num(node, 'alignment', 0),
          color: text ? undefined : DEFAULT_PLACEHOLDER_COLOR,
        });
        break;
      }
      case 'TextEdit': case 'CodeEdit': {
        const style = styleFor(doc, node, 'normal', 'TextEdit');
        drawStyleBox(ctx, style, rect);
        const inner = inset(rect, style.contentMargin);
        const text = textOf(node);
        drawText(ctx, node, text || textOf(node, 'placeholder_text'), inner, {
          vAlign: 0, wrap: true, color: text ? undefined : DEFAULT_PLACEHOLDER_COLOR,
        });
        break;
      }
      case 'ProgressBar': {
        const min = num(node, 'min_value', 0), max = num(node, 'max_value', 100);
        const value = num(node, 'value', 0);
        const frac = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
        drawStyleBox(ctx, styleFor(doc, node, 'background', 'ProgressBarBg'), rect);
        drawStyleBox(ctx, styleFor(doc, node, 'fill', 'ProgressBarFill'), { ...rect, w: rect.w * frac });
        if (bool(node, 'show_percentage', true)) {
          drawText(ctx, node, `${Math.round(frac * 100)}%`, rect, { hAlign: 1, size: 12 });
        }
        break;
      }
      case 'HSlider': case 'VSlider': {
        const vertical = type === 'VSlider';
        const min = num(node, 'min_value', 0), max = num(node, 'max_value', 100);
        const frac = max > min ? Math.max(0, Math.min(1, (num(node, 'value', 0) - min) / (max - min))) : 0;
        const track = vertical
          ? { x: rect.x + rect.w / 2 - 2, y: rect.y, w: 4, h: rect.h }
          : { x: rect.x, y: rect.y + rect.h / 2 - 2, w: rect.w, h: 4 };
        drawStyleBox(ctx, defaultStyleFor('SliderTrack'), track);
        ctx.fillStyle = DEFAULT_ACCENT;
        ctx.beginPath();
        const gx = vertical ? rect.x + rect.w / 2 : rect.x + rect.w * frac;
        const gy = vertical ? rect.y + rect.h * (1 - frac) : rect.y + rect.h / 2;
        ctx.arc(gx, gy, 7, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'HScrollBar': case 'VScrollBar':
        drawStyleBox(ctx, defaultStyleFor('ScrollBar'), rect);
        break;
      case 'HSeparator':
        drawStyleBox(ctx, defaultStyleFor('Separator'), { x: rect.x, y: rect.y + rect.h / 2 - 1, w: rect.w, h: 2 });
        break;
      case 'VSeparator':
        drawStyleBox(ctx, defaultStyleFor('Separator'), { x: rect.x + rect.w / 2 - 1, y: rect.y, w: 2, h: rect.h });
        break;
      case 'TextureButton': {
        const img = image(node, bool(node, 'disabled', false) ? 'texture_disabled' : 'texture_normal')
          || image(node, 'texture_normal');
        if (img) drawImage(ctx, img, rect, num(node, 'stretch_mode', 0));
        else outline(ctx, rect, type);
        break;
      }
      case 'TabContainer': {
        drawStyleBox(ctx, defaultStyleFor('TabBar'), { x: rect.x, y: rect.y, w: rect.w, h: 31 });
        const tabs = entry.children.filter((c) => c.kind === 'control');
        const current = num(node, 'current_tab', 0);
        ctx.font = `13px ${FONT_STACK}`;
        let tx = rect.x;
        tabs.forEach((tab, i) => {
          const tw = ctx.measureText(tab.name).width + 24;
          if (i === current) drawStyleBox(ctx, defaultStyleFor('TabActive'), { x: tx, y: rect.y, w: tw, h: 31 });
          ctx.fillStyle = i === current ? DEFAULT_FONT_COLOR : DEFAULT_FONT_DISABLED;
          ctx.textBaseline = 'middle';
          ctx.fillText(tab.name, tx + 12, rect.y + 16);
          tx += tw;
        });
        ctx.textBaseline = 'top';
        break;
      }
      case 'ItemList': case 'Tree':
        drawStyleBox(ctx, defaultStyleFor('LineEdit'), rect);
        break;
      case 'HSplitContainer': case 'VSplitContainer': case 'SplitContainer': {
        outline(ctx, rect, type);
        break;
      }
      default:
        if (entry.kind === 'control') outline(ctx, rect, OUTLINE_ONLY.has(type) ? type : (type || 'Instance'));
        break;
    }
    ctx.restore();
  };

  return { measure, draw, setDoc };
}
