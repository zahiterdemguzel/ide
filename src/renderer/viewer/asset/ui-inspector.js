import { findNode, attrStr, getProp } from '../../shared/tscn.js';
import { schemaFor, specFor, themeOverridesFor, THEME_BUCKET_KIND, KIND, parseValue, formatValue } from '../../shared/control-schema.js';
import { readProp, writeProp, writeRawProp, clearProp, extraProps, themeOverrideProps } from '../../shared/tscn-props.js';
import {
  ANCHOR_PRESETS, anchorsOf, offsetsOf, offsetsForRect, presetIdOf, applyPreset,
  writeAnchors, writeRect,
} from '../../shared/tscn-layout.js';
import { isContainerType } from '../../shared/control-layout.js';
import { makeField, fieldRow, NEW_STYLEBOX } from './ui-fields.js';

// The property inspector: a schema-driven panel over the selected node. It
// writes straight into the parsed document through tscn-props, which enforces
// Godot's rule that a property at its default is not written at all.

const el = (tag, cls, props = {}) => Object.assign(document.createElement(tag), { className: cls, ...props });

// The 16 layout presets, laid out as Godot's picker: three point rows, then the
// wide presets, then Full Rect.
const PRESET_GRID = [
  [0, 5, 1],
  [4, 8, 6],
  [2, 7, 3],
  [9, 13, 11],
  [10, 14, 12],
  [15],
];

export function createInspector(host, api) {
  const panel = el('div', 'model-edit-panel uis-inspector');
  const head = el('button', 'model-tree-head', { title: 'Toggle inspector' });
  head.innerHTML = '<span class="model-tree-caret">▾</span><span class="model-tree-title">Inspector</span>';
  head.addEventListener('click', () => panel.classList.toggle('collapsed'));
  const body = el('div', 'model-edit-body');
  panel.append(head, body);
  host.appendChild(panel);

  let showAll = false;
  // Explicit user open/close per group name; groups the user never touched
  // fall back to the caller's `open` default.
  const groupState = new Map();

  const section = (title, { collapsible = false, open = true } = {}) => {
    const s = el('div', 'model-edit-section');
    const h = el('div', 'model-edit-section-title uis-group-title', { textContent: title });
    const b = el('div', 'model-edit-section-body');
    if (collapsible) {
      const isOpen = groupState.has(title) ? groupState.get(title) : open;
      h.classList.add('uis-collapsible');
      h.addEventListener('click', () => { groupState.set(title, !isOpen); rebuild(); });
      if (!isOpen) b.style.display = 'none';
    }
    s.append(h, b);
    body.appendChild(s);
    return b;
  };

  // Every write goes through here: mutate, then let the editor record one
  // coalesced undo entry and repaint.
  const edit = (label, fn) => api.edit(label, fn);

  // --- layout ---
  const buildLayout = (parent, path, node, info) => {
    if (info.managed) {
      const owner = info.path.includes('/') ? info.path.slice(0, info.path.lastIndexOf('/')) : '.';
      const ownerType = api.getLayout().get(owner)?.type || 'container';
      parent.appendChild(el('div', 'uis-note', {
        textContent: `Laid out by ${ownerType} — position comes from size flags.`,
      }));
      for (const key of ['size_flags_horizontal', 'size_flags_vertical', 'size_flags_stretch_ratio', 'custom_minimum_size']) {
        const spec = specFor(info.type, key);
        if (spec) parent.appendChild(propRow(path, node, spec));
      }
      return;
    }

    // Preset picker.
    const anchors = anchorsOf(node);
    const active = presetIdOf(anchors);
    const grid = el('div', 'uis-presets');
    for (const row of PRESET_GRID) {
      const r = el('div', 'uis-preset-row');
      for (const id of row) {
        const preset = ANCHOR_PRESETS[id];
        const btn = el('button', 'uis-preset', { type: 'button', title: preset.name });
        btn.appendChild(presetGlyph(preset.anchors));
        if (id === active) btn.classList.add('on');
        btn.addEventListener('click', (e) => {
          const rect = api.getLayout().get(path).rect;
          const parentRect = parentSizeOf(path);
          const next = applyPreset(id, localRect(rect, path), parentRect, { keepRect: e.shiftKey });
          edit(`preset:${path}`, (doc) => writeRect(doc, path, next));
        });
        r.appendChild(btn);
      }
      grid.appendChild(r);
    }
    parent.append(grid, el('div', 'uis-note', { textContent: 'Shift-click: keep the current rectangle.' }));

    // Position / size, in the parent's coordinate space.
    const rect = localRect(info.rect, path);
    const posField = makeField({ kind: KIND.VECTOR2, step: 1 }, { x: rect.x, y: rect.y }, (v) => {
      applyLocalRect(path, { ...currentLocalRect(path), x: v.x, y: v.y }, 'pos');
    });
    const sizeField = makeField({ kind: KIND.VECTOR2, step: 1 }, { x: rect.w, y: rect.h }, (v) => {
      applyLocalRect(path, { ...currentLocalRect(path), w: v.x, h: v.y }, 'size');
    });
    parent.append(fieldRow('Position', posField), fieldRow('Size', sizeField));

    // Raw anchors and offsets, for the cases the presets can't express.
    const anchorField = makeField({ kind: KIND.RECT2, step: 0.01 },
      { x: anchors[0], y: anchors[1], w: anchors[2], h: anchors[3] },
      (v) => edit(`anchors:${path}`, (doc) => writeAnchors(findNode(doc, path), [v.x, v.y, v.w, v.h])));
    const offsets = offsetsOf(node);
    const offsetField = makeField({ kind: KIND.RECT2, step: 1 },
      { x: offsets[0], y: offsets[1], w: offsets[2], h: offsets[3] },
      (v) => edit(`offsets:${path}`, (doc) => writeRect(doc, path, { anchors: anchorsOf(findNode(doc, path)), offsets: [v.x, v.y, v.w, v.h] })));
    parent.append(
      fieldRow('Anchors', anchorField, { title: 'left, top, right, bottom — fractions of the parent' }),
      fieldRow('Offsets', offsetField, { title: 'left, top, right, bottom — pixels from the anchors' }),
    );
    for (const key of ['grow_horizontal', 'grow_vertical', 'custom_minimum_size', 'size_flags_horizontal', 'size_flags_vertical']) {
      const spec = specFor(info.type, key);
      if (spec && (showAll || getProp(node, key) !== undefined)) parent.appendChild(propRow(path, node, spec));
    }
  };

  // A tiny diagram of where a preset anchors, drawn from the anchor fractions.
  const presetGlyph = (a) => {
    const box = el('span', 'uis-preset-glyph');
    const mark = el('span', 'uis-preset-mark');
    // A point preset would otherwise be a zero-width mark pinned to the edge,
    // so give it a minimum size and pull it back inside the box.
    const span = (lo, hi) => {
      const size = Math.max(22, (hi - lo) * 100);
      return { pos: Math.min(lo * 100, 100 - size), size };
    };
    const h = span(a[0], a[2]), v = span(a[1], a[3]);
    mark.style.left = h.pos + '%';
    mark.style.width = h.size + '%';
    mark.style.top = v.pos + '%';
    mark.style.height = v.size + '%';
    box.appendChild(mark);
    return box;
  };

  const parentSizeOf = (path) => {
    if (path === '.') return api.getViewportSize();
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    const p = api.getLayout().get(parentPath);
    return p ? { w: p.rect.w, h: p.rect.h } : api.getViewportSize();
  };
  const parentOriginOf = (path) => {
    if (path === '.') return { x: 0, y: 0 };
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    const p = api.getLayout().get(parentPath);
    return p ? { x: p.rect.x, y: p.rect.y } : { x: 0, y: 0 };
  };
  const localRect = (rect, path) => {
    const o = parentOriginOf(path);
    return { x: rect.x - o.x, y: rect.y - o.y, w: rect.w, h: rect.h };
  };
  const currentLocalRect = (path) => localRect(api.getLayout().get(path).rect, path);

  const applyLocalRect = (path, rect, label) => {
    edit(`rect:${path}:${label}`, (doc) => {
      const node = findNode(doc, path);
      const anchors = anchorsOf(node);
      writeRect(doc, path, { anchors, offsets: offsetsForRect(rect, anchors, parentSizeOf(path)) });
    });
  };

  // --- generic schema rows ---
  const propRow = (path, node, spec) => {
    const value = readProp(node, spec);
    const written = getProp(node, spec.key) !== undefined;
    const field = makeField(spec, value, (v) => {
      edit(`prop:${path}:${spec.key}`, (doc) => {
        // A brand-new StyleBox is created here so the sub_resource and the
        // property pointing at it share one undo entry.
        writeProp(findNode(doc, path), spec, v === NEW_STYLEBOX ? api.newStyleBox(doc) : v);
      });
    }, fieldCtx(path));
    const row = fieldRow(spec.label, field, {
      title: spec.key,
      onReset: written ? () => edit(`clear:${path}:${spec.key}`, (doc) => clearProp(findNode(doc, path), spec.key)) : null,
    });
    if (written) row.classList.add('uis-set');
    return row;
  };

  const fieldCtx = (path) => ({
    pickResource: (type) => api.pickResource(type, path),
    describeResource: api.describeResource,
    editStyleBox: (ref) => api.editStyleBox(ref),
    nodePaths: () => [...api.getLayout().keys()].filter((p) => p !== path),
  });

  // --- theme overrides ---
  const buildThemeOverrides = (parent, path, node, type) => {
    const present = themeOverrideProps(node);
    for (const item of present) {
      const kind = THEME_BUCKET_KIND[item.bucket];
      const spec = { key: item.key, label: item.name, kind, def: null };
      const field = makeField(spec, parseValue(kind, item.value), (v) => {
        edit(`theme:${path}:${item.key}`, (doc) => {
          const n = findNode(doc, path);
          const next = v === NEW_STYLEBOX ? api.newStyleBox(doc) : v;
          if (next === null || next === undefined || next === '') clearProp(n, item.key);
          else writeRawProp(n, item.key, kind === KIND.STYLEBOX || kind === KIND.FONT ? String(next) : formatValue(kind, next));
        });
      }, fieldCtx(path));
      const row = fieldRow(`${item.bucket.replace('_', ' ')} / ${item.name}`, field, {
        title: item.key,
        onReset: () => edit(`theme-clear:${path}:${item.key}`, (doc) => clearProp(findNode(doc, path), item.key)),
      });
      row.classList.add('uis-set');
      parent.appendChild(row);
    }

    const items = themeOverridesFor(type);
    const options = [];
    for (const bucket of Object.keys(items)) {
      for (const name of items[bucket]) {
        const key = `theme_override_${bucket}/${name}`;
        if (!present.some((p) => p.key === key)) options.push({ key, bucket, name });
      }
    }
    if (!options.length) {
      if (!present.length) parent.appendChild(el('div', 'model-edit-empty', { textContent: 'No overrides.' }));
      return;
    }
    const select = el('select', 'model-edit-select');
    select.appendChild(el('option', '', { value: '', textContent: '+ Add override…' }));
    for (const o of options) select.appendChild(el('option', '', { value: o.key, textContent: `${o.bucket.replace('_', ' ')} / ${o.name}` }));
    select.addEventListener('change', () => {
      const opt = options.find((o) => o.key === select.value);
      if (!opt) return;
      const kind = THEME_BUCKET_KIND[opt.bucket];
      edit(`theme-add:${path}:${opt.key}`, (doc) => {
        // Seed the override with something meaningful so the new row is
        // immediately editable; a style bucket gets a real StyleBoxFlat.
        const seed = kind === KIND.STYLEBOX ? api.newStyleBox(doc)
          : kind === KIND.COLOR ? 'Color(1, 1, 1, 1)'
            : kind === KIND.INT ? '0' : null;
        if (seed !== null) writeRawProp(findNode(doc, path), opt.key, seed);
      });
      if (THEME_BUCKET_KIND[opt.bucket] === KIND.FONT) {
        api.pickResource('Font').then((ref) => {
          if (ref) edit(`theme-font:${path}:${opt.key}`, (doc) => writeRawProp(findNode(doc, path), opt.key, ref));
        });
      }
    });
    parent.appendChild(select);
  };

  // --- rebuild ---
  const rebuild = () => {
    body.innerHTML = '';
    const sel = api.getSelection();
    if (sel.length !== 1) {
      section('Selection').appendChild(el('div', 'model-edit-empty', {
        textContent: sel.length ? `${sel.length} nodes selected.` : 'Nothing selected.',
      }));
      return;
    }
    const path = sel[0];
    const doc = api.getDoc();
    const node = findNode(doc, path);
    const info = api.getLayout().get(path);
    if (!node || !info) return;
    const type = attrStr(node, 'type') || 'Node';

    const nodeBody = section('Node');
    nodeBody.appendChild(el('div', 'uis-node-head', {
      textContent: `${attrStr(node, 'name')}  ·  ${type}`,
    }));
    nodeBody.appendChild(el('div', 'uis-path', { textContent: path }));
    if (isContainerType(type)) {
      nodeBody.appendChild(el('div', 'uis-note', { textContent: 'Container — it positions its Control children.' }));
    }

    if (info.kind === 'control') buildLayout(section('Layout'), path, node, info);

    const schema = schemaFor(type);
    for (const group of schema.groups) {
      if (group.name === 'Layout') continue; // owned by the Layout section
      const visible = group.props.filter((s) => showAll || getProp(node, s.key) !== undefined);
      if (!visible.length) continue;
      // By default a group opens only when the file already sets something in
      // it, so an untouched group stays folded away.
      const open = group.props.some((s) => getProp(node, s.key) !== undefined);
      const b = section(group.name, { collapsible: true, open });
      for (const spec of visible) b.appendChild(propRow(path, node, spec));
    }

    // Properties Godot would write but that are still at their default: offered
    // behind a picker rather than shown as a wall of untouched rows.
    if (!showAll) {
      const hidden = schema.groups.flatMap((g) => g.props)
        .filter((s) => getProp(node, s.key) === undefined && s.group !== 'Layout');
      if (hidden.length) {
        const b = section('Add property');
        const select = el('select', 'model-edit-select');
        select.appendChild(el('option', '', { value: '', textContent: `+ ${hidden.length} more…` }));
        for (const s of hidden) select.appendChild(el('option', '', { value: s.key, textContent: `${s.group} / ${s.label}` }));
        select.addEventListener('change', () => {
          const spec = hidden.find((s) => s.key === select.value);
          if (!spec) return;
          // Write the default explicitly so the row appears; it is a real edit,
          // matching what Godot's "pin" does.
          edit(`add:${path}:${spec.key}`, (d) => writeRawProp(findNode(d, path), spec.key, formatValue(spec.kind, spec.def ?? 0)));
        });
        b.appendChild(select);
      }
    }

    buildThemeOverrides(section('Theme Overrides', { collapsible: true }), path, node, type);

    const others = extraProps(node, type);
    if (others.length) {
      const b = section('Other', { collapsible: true });
      b.appendChild(el('div', 'uis-note', { textContent: 'Properties this editor does not model — edited as raw text.' }));
      for (const item of others) {
        const field = makeField({ kind: 'raw' }, item.value, (v) => {
          edit(`raw:${path}:${item.key}`, (d) => writeRawProp(findNode(d, path), item.key, v));
        });
        b.appendChild(fieldRow(item.key, field, { title: item.key }));
      }
    }

    const foot = section('Inspector');
    const toggle = el('label', 'uis-flag');
    const cb = el('input', '', { type: 'checkbox' });
    cb.checked = showAll;
    cb.addEventListener('change', () => { showAll = cb.checked; rebuild(); });
    toggle.append(cb, document.createTextNode('Show all properties'));
    foot.appendChild(toggle);
  };

  rebuild();
  return { panel, rebuild, destroy: () => panel.remove() };
}
