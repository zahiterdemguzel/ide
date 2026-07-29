import { getProp, setProp, removeProp } from './tscn.js';
import {
  KIND, schemaFor, specFor, parseValue, formatValue, valuesEqual, LAYOUT_RECT_KEYS,
} from './control-schema.js';

// The bridge between the inspector's typed values and the raw .tscn text.
// Godot omits every property still at its default, so this module's single
// most important rule is: writing a default REMOVES the line. Everything the
// edit does not touch keeps its original raw string, which is what makes a
// hand-written scene survive an edit with a one-line diff.

export function readRaw(node, key) { return getProp(node, key); }

// A property's current value, falling back to the schema default.
export function readProp(node, spec) {
  const raw = getProp(node, spec.key);
  return raw === undefined ? spec.def : parseValue(spec.kind, raw);
}

export function writeProp(node, spec, value) {
  if (valuesEqual(spec.kind, value, spec.def)) { removeProp(node, spec.key); return; }
  // Resource-ish kinds hold a raw reference string; an empty one means "unset".
  if (spec.kind === KIND.RESOURCE || spec.kind === KIND.STYLEBOX || spec.kind === KIND.FONT) {
    if (!value) removeProp(node, spec.key);
    else setProp(node, spec.key, String(value));
    return;
  }
  setProp(node, spec.key, formatValue(spec.kind, value));
}

export function writeRawProp(node, key, raw) {
  if (raw === undefined || raw === '') removeProp(node, key);
  else setProp(node, key, raw);
}

export function clearProp(node, key) { removeProp(node, key); }

const isThemeOverride = (key) => key.startsWith('theme_override_');

// Properties written in the file that no schema group covers: script exports,
// metadata, properties of node types the editor does not model. The inspector
// shows them as raw text so an edit can never drop them.
export function extraProps(node, type) {
  const known = schemaFor(type).byKey;
  return node.props
    .filter((p) => !known.has(p.key) && !isThemeOverride(p.key) && !LAYOUT_RECT_KEYS.has(p.key))
    .map((p) => ({ key: p.key, value: p.value }));
}

// theme_override_<bucket>/<name> properties present on the node.
export function themeOverrideProps(node) {
  const out = [];
  for (const p of node.props) {
    const m = /^theme_override_(colors|fonts|font_sizes|constants|styles)\/(.+)$/.exec(p.key);
    if (m) out.push({ key: p.key, bucket: m[1], name: m[2], value: p.value });
  }
  return out;
}

// Which schema properties are actually written in the file — what the
// inspector shows when "non-defaults only" is on (Godot's own behaviour).
export function writtenProps(node, type) {
  const out = [];
  for (const group of schemaFor(type).groups) {
    for (const spec of group.props) if (getProp(node, spec.key) !== undefined) out.push(spec);
  }
  return out;
}

export { specFor, schemaFor, parseValue, formatValue, valuesEqual };
