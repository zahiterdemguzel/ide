import { KIND } from '../../shared/control-schema.js';

// Sentinel a StyleBox field emits when the user asks for a fresh one. The
// inspector creates the sub-resource *inside* its edit transaction, so the new
// resource and the property that points at it land in the same undo entry.
export const NEW_STYLEBOX = Symbol('new-stylebox');

// One editor widget per property KIND. Each returns `{ el, set }` so the
// inspector can rebuild values without rebuilding the DOM (which would steal
// focus mid-typing). `onChange(value)` fires per keystroke/drag; the editor
// coalesces those into one undo entry.

const el = (tag, cls, props = {}) => Object.assign(document.createElement(tag), { className: cls, ...props });

function numberInput(value, { min, max, step } = {}) {
  const input = el('input', 'uis-input uis-num', { type: 'number', value: String(value ?? 0) });
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = String(step ?? 1);
  return input;
}

// 0..1 float ⇄ #rrggbb, keeping alpha on a separate control the way Godot's
// colour picker does.
const to255 = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => to255(v).toString(16).padStart(2, '0')).join('');
const fromHex = (hex, a) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
  a,
});

export function makeField(spec, value, onChange, ctx = {}) {
  switch (spec.kind) {
    case KIND.BOOL: {
      const input = el('input', 'uis-check', { type: 'checkbox' });
      input.checked = !!value;
      input.addEventListener('change', () => onChange(input.checked));
      return { el: input, set: (v) => { input.checked = !!v; } };
    }

    case KIND.INT: case KIND.FLOAT: {
      const step = spec.kind === KIND.INT ? 1 : (spec.step ?? 0.01);
      const input = numberInput(value, { min: spec.min, max: spec.max, step });
      input.addEventListener('input', () => {
        const n = Number(input.value);
        if (Number.isFinite(n)) onChange(spec.kind === KIND.INT ? Math.round(n) : n);
      });
      return { el: input, set: (v) => { if (document.activeElement !== input) input.value = String(v ?? 0); } };
    }

    case KIND.STRING: {
      const input = el('input', 'uis-input', { type: 'text', value: String(value ?? '') });
      input.addEventListener('input', () => onChange(input.value));
      return { el: input, set: (v) => { if (document.activeElement !== input) input.value = String(v ?? ''); } };
    }

    case KIND.MULTILINE: {
      const input = el('textarea', 'uis-input uis-multiline', { rows: 3, value: String(value ?? '') });
      input.addEventListener('input', () => onChange(input.value));
      return { el: input, set: (v) => { if (document.activeElement !== input) input.value = String(v ?? ''); } };
    }

    case KIND.ENUM: {
      const select = el('select', 'uis-input');
      for (const [v, label] of spec.options || []) select.appendChild(el('option', '', { value: String(v), textContent: label }));
      select.value = String(value ?? spec.def);
      select.addEventListener('change', () => onChange(Number(select.value)));
      return { el: select, set: (v) => { select.value = String(v ?? spec.def); } };
    }

    case KIND.FLAGS: {
      const wrap = el('div', 'uis-flags');
      const boxes = [];
      for (const [bit, label] of spec.options || []) {
        const lab = el('label', 'uis-flag');
        const cb = el('input', '', { type: 'checkbox' });
        cb.checked = ((value ?? 0) & bit) !== 0;
        cb.addEventListener('change', () => {
          let out = 0;
          boxes.forEach(({ bit: b, cb: c }) => { if (c.checked) out |= b; });
          onChange(out);
        });
        boxes.push({ bit, cb });
        lab.append(cb, document.createTextNode(label));
        wrap.appendChild(lab);
      }
      return { el: wrap, set: (v) => boxes.forEach(({ bit, cb }) => { cb.checked = ((v ?? 0) & bit) !== 0; }) };
    }

    case KIND.VECTOR2: case KIND.RECT2: {
      const keys = spec.kind === KIND.VECTOR2 ? ['x', 'y'] : ['x', 'y', 'w', 'h'];
      const wrap = el('div', 'uis-vec');
      const inputs = {};
      const current = () => keys.reduce((o, k) => { o[k] = Number(inputs[k].value) || 0; return o; }, {});
      for (const k of keys) {
        const cell = el('label', 'uis-vec-cell');
        const input = numberInput((value || {})[k] ?? 0, { step: spec.step ?? 1 });
        input.addEventListener('input', () => onChange(current()));
        inputs[k] = input;
        cell.append(el('span', 'uis-vec-key', { textContent: k }), input);
        wrap.appendChild(cell);
      }
      return {
        el: wrap,
        set: (v) => keys.forEach((k) => {
          if (document.activeElement !== inputs[k]) inputs[k].value = String((v || {})[k] ?? 0);
        }),
      };
    }

    case KIND.COLOR: {
      const wrap = el('div', 'uis-color');
      const swatch = el('input', 'uis-swatch', { type: 'color' });
      const alpha = numberInput((value || {}).a ?? 1, { min: 0, max: 1, step: 0.01 });
      alpha.title = 'Alpha';
      swatch.value = hexOf(value || { r: 1, g: 1, b: 1 });
      const emit = () => onChange(fromHex(swatch.value, Number(alpha.value)));
      swatch.addEventListener('input', emit);
      alpha.addEventListener('input', emit);
      wrap.append(swatch, alpha);
      return {
        el: wrap,
        set: (v) => {
          swatch.value = hexOf(v || { r: 1, g: 1, b: 1 });
          if (document.activeElement !== alpha) alpha.value = String((v || {}).a ?? 1);
        },
      };
    }

    case KIND.NODEPATH: {
      const wrap = el('div', 'uis-picker');
      const select = el('select', 'uis-input');
      const fill = (current) => {
        select.innerHTML = '';
        select.appendChild(el('option', '', { value: '', textContent: '(none)' }));
        for (const p of ctx.nodePaths?.() || []) select.appendChild(el('option', '', { value: p, textContent: p }));
        if (current && !Array.from(select.options).some((o) => o.value === current)) {
          select.appendChild(el('option', '', { value: current, textContent: current + ' (missing)' }));
        }
        select.value = current || '';
      };
      fill(value || '');
      select.addEventListener('change', () => onChange(select.value));
      wrap.appendChild(select);
      return { el: wrap, set: fill };
    }

    case KIND.RESOURCE: case KIND.FONT: {
      const wrap = el('div', 'uis-picker');
      const btn = el('button', 'uis-res', { type: 'button' });
      const clear = el('button', 'uis-res-clear', { type: 'button', textContent: '✕', title: 'Clear' });
      const label = (v) => (v ? (ctx.describeResource?.(v) || String(v)) : '(empty)');
      btn.textContent = label(value);
      btn.title = 'Choose a resource';
      btn.addEventListener('click', async () => {
        const picked = await ctx.pickResource?.(spec.resourceType || 'Resource');
        if (picked !== undefined && picked !== null) onChange(picked);
      });
      clear.addEventListener('click', () => onChange(null));
      wrap.append(btn, clear);
      return { el: wrap, set: (v) => { btn.textContent = label(v); } };
    }

    case KIND.STYLEBOX: {
      const wrap = el('div', 'uis-picker');
      const btn = el('button', 'uis-res', { type: 'button' });
      const clear = el('button', 'uis-res-clear', { type: 'button', textContent: '✕', title: 'Clear' });
      btn.textContent = value ? (ctx.describeResource?.(value) || 'StyleBox') : 'New StyleBoxFlat…';
      btn.addEventListener('click', () => {
        if (value) ctx.editStyleBox?.(value);
        else onChange(NEW_STYLEBOX);
      });
      clear.addEventListener('click', () => onChange(null));
      wrap.append(btn, clear);
      return {
        el: wrap,
        set: (v) => { btn.textContent = v ? (ctx.describeResource?.(v) || 'StyleBox') : 'New StyleBoxFlat…'; },
      };
    }

    default: {
      const input = el('input', 'uis-input', { type: 'text', value: value == null ? '' : String(value) });
      input.addEventListener('input', () => onChange(input.value));
      return { el: input, set: (v) => { if (document.activeElement !== input) input.value = v == null ? '' : String(v); } };
    }
  }
}

// A labelled inspector row wrapping a field.
export function fieldRow(labelText, field, { title, onReset } = {}) {
  const row = el('div', 'uis-row');
  const label = el('span', 'uis-label', { textContent: labelText });
  if (title) label.title = title;
  row.append(label, field.el);
  if (onReset) {
    const reset = el('button', 'uis-reset', { type: 'button', textContent: '⟲', title: 'Reset to default' });
    reset.addEventListener('click', onReset);
    row.appendChild(reset);
  }
  return row;
}
