import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn, serializeTscn, findNode, getProp } from '../src/renderer/shared/tscn.js';
import {
  ANCHOR_PRESETS, anchorsOf, offsetsOf, rectOf, offsetsForRect, presetIdOf,
  applyPreset, growDirsOf, sizeFlagsOf, customMinSizeOf, visibleOf,
  writeAnchors, writeRect,
} from '../src/renderer/shared/tscn-layout.js';

const PARENT = { w: 1000, h: 600 };

const SCENE = `[gd_scene format=3]

[node name="Root" type="Control"]
anchors_preset = 15
anchor_right = 1
anchor_bottom = 1

[node name="Card" type="PanelContainer" parent="."]
offset_left = 40
offset_top = 20
offset_right = 240
offset_bottom = 120
custom_minimum_size = Vector2(80, 30)
size_flags_horizontal = 3
grow_horizontal = 0
visible = false
`;

test('reads anchors, offsets and layout flags with Godot defaults', () => {
  const doc = parseTscn(SCENE);
  const card = findNode(doc, 'Card');
  assert.deepEqual(anchorsOf(card), [0, 0, 0, 0]);
  assert.deepEqual(offsetsOf(card), [40, 20, 240, 120]);
  assert.deepEqual(growDirsOf(card), { h: 0, v: 1 });
  assert.deepEqual(sizeFlagsOf(card), { h: 3, v: 1, stretchRatio: 1 });
  assert.deepEqual(customMinSizeOf(card), { x: 80, y: 30 });
  assert.equal(visibleOf(card), false);
  assert.equal(visibleOf(findNode(doc, '.')), true);
});

test('rectOf composes anchors against the parent size', () => {
  assert.deepEqual(rectOf([0, 0, 0, 0], [10, 20, 110, 70], PARENT), { x: 10, y: 20, w: 100, h: 50 });
  assert.deepEqual(rectOf([0, 0, 1, 1], [0, 0, 0, 0], PARENT), { x: 0, y: 0, w: 1000, h: 600 });
  assert.deepEqual(rectOf([1, 0, 1, 1], [-200, 0, 0, 0], PARENT), { x: 800, y: 0, w: 200, h: 600 });
  assert.deepEqual(rectOf([0.5, 0.5, 0.5, 0.5], [-50, -25, 50, 25], PARENT), { x: 450, y: 275, w: 100, h: 50 });
});

test('offsetsForRect is the exact inverse of rectOf', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const anchors = [rnd(), rnd(), rnd(), rnd()];
    const rect = { x: rnd() * 500, y: rnd() * 500, w: rnd() * 300, h: rnd() * 300 };
    const back = rectOf(anchors, offsetsForRect(rect, anchors, PARENT), PARENT);
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(back[k] - rect[k]) < 1e-9, k);
  }
});

test('presetIdOf recognises every preset and rejects a custom anchor set', () => {
  for (const p of ANCHOR_PRESETS) assert.equal(presetIdOf(p.anchors), p.id);
  assert.equal(presetIdOf([0.25, 0, 0.75, 1]), null);
});

test('applyPreset keeps the rect or snaps into the preset region', () => {
  const rect = { x: 100, y: 100, w: 200, h: 80 };
  const kept = applyPreset(3, rect, PARENT, { keepRect: true }); // Bottom Right
  assert.deepEqual(kept.anchors, [1, 1, 1, 1]);
  assert.deepEqual(rectOf(kept.anchors, kept.offsets, PARENT), rect);

  const full = applyPreset(15, rect, PARENT);
  assert.deepEqual(full.offsets, [0, 0, 0, 0]);
  assert.deepEqual(rectOf(full.anchors, full.offsets, PARENT), { x: 0, y: 0, w: 1000, h: 600 });

  const centre = applyPreset(8, rect, PARENT);
  assert.deepEqual(centre.offsets, [-100, -40, 100, 40]);
  assert.deepEqual(rectOf(centre.anchors, centre.offsets, PARENT), { x: 400, y: 260, w: 200, h: 80 });

  const bottomRight = applyPreset(3, rect, PARENT);
  assert.deepEqual(bottomRight.offsets, [-200, -80, 0, 0]);
});

test('writeAnchors omits defaults and records the preset', () => {
  const doc = parseTscn(SCENE);
  const card = findNode(doc, 'Card');
  writeAnchors(card, [0, 0, 1, 1]);
  assert.equal(getProp(card, 'anchor_left'), undefined);
  assert.equal(getProp(card, 'anchor_right'), '1');
  assert.equal(getProp(card, 'anchors_preset'), '15');

  writeAnchors(card, [0.25, 0, 0.75, 1]);
  assert.equal(getProp(card, 'anchors_preset'), '-1');

  writeAnchors(card, [0, 0, 0, 0]);
  assert.equal(getProp(card, 'anchors_preset'), undefined);
  assert.equal(getProp(card, 'anchor_right'), undefined);
});

test('writeRect round-trips through the serializer and drops zero offsets', () => {
  const doc = parseTscn(SCENE);
  const anchors = [0, 0, 1, 1];
  writeRect(doc, 'Card', { anchors, offsets: [0, 0, 0, 0] });
  const card = findNode(doc, 'Card');
  for (const k of ['offset_left', 'offset_top', 'offset_right', 'offset_bottom']) {
    assert.equal(getProp(card, k), undefined);
  }
  // untouched properties survive
  assert.equal(getProp(card, 'custom_minimum_size'), 'Vector2(80, 30)');
  const text = serializeTscn(doc);
  assert.equal(serializeTscn(parseTscn(text)), text);
});

test('a container child records only layout_mode = 2', () => {
  const doc = parseTscn(SCENE);
  writeRect(doc, 'Card', { anchors: [0, 0, 1, 1], offsets: [1, 2, 3, 4], containerChild: true });
  const card = findNode(doc, 'Card');
  assert.equal(getProp(card, 'layout_mode'), '2');
  assert.equal(getProp(card, 'offset_left'), '40'); // untouched
});
