import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn, serializeTscn, findNode, getProp } from '../src/renderer/shared/tscn.js';
import { specFor } from '../src/renderer/shared/control-schema.js';
import {
  readProp, writeProp, writeRawProp, clearProp, extraProps, themeOverrideProps, writtenProps,
} from '../src/renderer/shared/tscn-props.js';

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://menu.gd" id="1_menu"]

[node name="Menu" type="Control"]
anchor_right = 1
anchor_bottom = 1
script = ExtResource("1_menu")
speed_multiplier = 2.5

[node name="Play" type="Button" parent="."]
offset_right = 120
offset_bottom = 32
text = "Play"
flat = true
theme_override_colors/font_color = Color(1, 0.5, 0, 1)
theme_override_constants/h_separation = 8
metadata/tags = {
"kind": "primary"
}

[node name="Odd" type="MyWidget" parent="."]
weird_thing = 42

[connection signal="pressed" from="Play" to="." method="_on_play"]
`;

test('readProp falls back to the schema default', () => {
  const doc = parseTscn(SCENE);
  const play = findNode(doc, 'Play');
  assert.equal(readProp(play, specFor('Button', 'text')), 'Play');
  assert.equal(readProp(play, specFor('Button', 'flat')), true);
  assert.equal(readProp(play, specFor('Button', 'disabled')), false); // absent → default
  assert.equal(readProp(play, specFor('Button', 'alignment')), 1);
});

test('writing a non-default adds the line, writing the default removes it', () => {
  const doc = parseTscn(SCENE);
  const play = findNode(doc, 'Play');
  writeProp(play, specFor('Button', 'disabled'), true);
  assert.equal(getProp(play, 'disabled'), 'true');
  writeProp(play, specFor('Button', 'disabled'), false);
  assert.equal(getProp(play, 'disabled'), undefined);
  writeProp(play, specFor('Button', 'flat'), false);
  assert.equal(getProp(play, 'flat'), undefined);
});

test('an unset resource property is removed rather than written empty', () => {
  const doc = parseTscn(SCENE);
  const play = findNode(doc, 'Play');
  writeProp(play, specFor('Button', 'icon'), 'ExtResource("2_i")');
  assert.equal(getProp(play, 'icon'), 'ExtResource("2_i")');
  writeProp(play, specFor('Button', 'icon'), null);
  assert.equal(getProp(play, 'icon'), undefined);
});

test('extraProps surfaces script exports and unknown-type properties', () => {
  const doc = parseTscn(SCENE);
  assert.deepEqual(
    extraProps(findNode(doc, '.'), 'Control').map((p) => p.key),
    ['script', 'speed_multiplier'],
  );
  assert.deepEqual(
    extraProps(findNode(doc, 'Play'), 'Button').map((p) => p.key),
    ['metadata/tags'],
  );
  // A type with no schema at all still lists everything it has.
  assert.deepEqual(extraProps(findNode(doc, 'Odd'), 'MyWidget').map((p) => p.key), ['weird_thing']);
});

test('theme overrides are grouped by bucket', () => {
  const doc = parseTscn(SCENE);
  assert.deepEqual(themeOverrideProps(findNode(doc, 'Play')), [
    { key: 'theme_override_colors/font_color', bucket: 'colors', name: 'font_color', value: 'Color(1, 0.5, 0, 1)' },
    { key: 'theme_override_constants/h_separation', bucket: 'constants', name: 'h_separation', value: '8' },
  ]);
});

test('writtenProps lists only what the file actually carries', () => {
  const doc = parseTscn(SCENE);
  assert.deepEqual(writtenProps(findNode(doc, 'Play'), 'Button').map((s) => s.key), ['text', 'flat']);
});

test('raw writes and clears go through untouched', () => {
  const doc = parseTscn(SCENE);
  const odd = findNode(doc, 'Odd');
  writeRawProp(odd, 'weird_thing', '43');
  assert.equal(getProp(odd, 'weird_thing'), '43');
  writeRawProp(odd, 'weird_thing', '');
  assert.equal(getProp(odd, 'weird_thing'), undefined);
  clearProp(findNode(doc, 'Play'), 'text');
  assert.equal(getProp(findNode(doc, 'Play'), 'text'), undefined);
});

test('editing one property changes exactly one line of the file', () => {
  const doc = parseTscn(SCENE);
  writeProp(findNode(doc, 'Play'), specFor('Button', 'text'), 'Start');
  const before = SCENE.split('\n');
  const after = serializeTscn(doc).split('\n');
  assert.equal(before.length, after.length);
  const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(changed.map((i) => after[i]), ['text = "Start"']);
});
