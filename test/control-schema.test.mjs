import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND, schemaFor, specFor, defaultOf, themeOverridesFor, THEME_BUCKET_KIND,
  parseValue, formatValue, valuesEqual,
} from '../src/renderer/shared/control-schema.js';

test('a schema inherits its chain without duplicating a key', () => {
  const schema = schemaFor('Button');
  const keys = schema.groups.flatMap((g) => g.props.map((p) => p.key));
  assert.equal(new Set(keys).size, keys.length);
  for (const key of ['visible', 'modulate', 'custom_minimum_size', 'mouse_filter', 'disabled', 'text', 'flat']) {
    assert.ok(keys.includes(key), key);
  }
  // A subclass default wins over its parent's.
  assert.equal(defaultOf('Button', 'alignment'), 1);
  assert.equal(defaultOf('LineEdit', 'alignment'), 0);
});

test('layout bookkeeping properties stay out of the generic groups', () => {
  const keys = schemaFor('Control').groups.flatMap((g) => g.props.map((p) => p.key));
  for (const key of ['anchor_left', 'offset_top', 'layout_mode', 'anchors_preset']) {
    assert.ok(!keys.includes(key), key);
  }
});

test('specFor finds inherited specs and misses unknown keys', () => {
  assert.equal(specFor('VBoxContainer', 'separation'), null);
  assert.equal(specFor('VBoxContainer', 'alignment').kind, KIND.ENUM);
  assert.equal(specFor('CheckBox', 'button_pressed').kind, KIND.BOOL);
  assert.equal(specFor('HSlider', 'max_value').def, 100);
});

test('theme override names merge along the chain', () => {
  const items = themeOverridesFor('CheckBox');
  assert.ok(items.colors.includes('font_color'));
  assert.ok(items.styles.includes('pressed'));
  assert.deepEqual(themeOverridesFor('VBoxContainer').constants, ['separation']);
  assert.equal(THEME_BUCKET_KIND.styles, KIND.STYLEBOX);
});

test('every kind round-trips through parseValue / formatValue', () => {
  const cases = [
    [KIND.BOOL, true, 'true'],
    [KIND.BOOL, false, 'false'],
    [KIND.INT, 7, '7'],
    [KIND.FLOAT, 1.5, '1.5'],
    [KIND.ENUM, 2, '2'],
    [KIND.FLAGS, 3, '3'],
    [KIND.STRING, 'Play', '"Play"'],
    [KIND.MULTILINE, 'a\nb', '"a\nb"'],
    [KIND.VECTOR2, { x: 1, y: 2 }, 'Vector2(1, 2)'],
    [KIND.RECT2, { x: 0, y: 1, w: 2, h: 3 }, 'Rect2(0, 1, 2, 3)'],
    [KIND.COLOR, { r: 1, g: 0, b: 0, a: 1 }, 'Color(1, 0, 0, 1)'],
    [KIND.NODEPATH, '../Player', 'NodePath("../Player")'],
  ];
  for (const [kind, value, raw] of cases) {
    assert.equal(formatValue(kind, value), raw, kind);
    assert.ok(valuesEqual(kind, parseValue(kind, raw), value), kind);
  }
});

test('quotes and backslashes survive a string round-trip', () => {
  const s = 'say "hi"\\ok';
  assert.equal(parseValue(KIND.STRING, formatValue(KIND.STRING, s)), s);
});

test('a colour without alpha reads as opaque', () => {
  assert.deepEqual(parseValue(KIND.COLOR, 'Color(0.5, 0.25, 0, 1)'), { r: 0.5, g: 0.25, b: 0, a: 1 });
  assert.ok(valuesEqual(KIND.COLOR, parseValue(KIND.COLOR, 'Color(1, 1, 1)'), { r: 1, g: 1, b: 1, a: 1 }));
});

test('valuesEqual tolerates float noise and signed zero', () => {
  assert.ok(valuesEqual(KIND.FLOAT, -0, 0));
  assert.ok(valuesEqual(KIND.FLOAT, 1, 1 + 1e-9));
  assert.ok(!valuesEqual(KIND.FLOAT, 1, 1.01));
  assert.ok(valuesEqual(KIND.VECTOR2, { x: 0, y: -0 }, { x: 0, y: 0 }));
  assert.ok(!valuesEqual(KIND.STRING, 'a', 'b'));
});

test('resource kinds keep their raw reference string', () => {
  assert.equal(parseValue(KIND.RESOURCE, 'ExtResource("1_a")'), 'ExtResource("1_a")');
  assert.equal(formatValue(KIND.STYLEBOX, 'SubResource("StyleBoxFlat_1")'), 'SubResource("StyleBoxFlat_1")');
});
