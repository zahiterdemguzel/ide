import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn } from '../src/renderer/shared/tscn.js';
import {
  buildControlTree, isContainerType, minimumSizeOf, layoutScene,
  pickAt, pickInRect, snapTargets, snapRect,
} from '../src/renderer/shared/control-layout.js';

const VIEW = { width: 1000, height: 600 };
const scene = (body) => parseTscn(`[gd_scene format=3]\n\n${body}`);
const lay = (doc, measure) => layoutScene(doc, { viewportSize: VIEW, measure });
const rect = (layout, path) => {
  const i = layout.get(path);
  return { x: i.rect.x, y: i.rect.y, w: i.rect.w, h: i.rect.h };
};

const NESTED = scene(`[node name="Root" type="Control"]
anchor_right = 1
anchor_bottom = 1

[node name="Panel" type="Panel" parent="."]
offset_left = 100
offset_top = 50
offset_right = 500
offset_bottom = 350

[node name="Inner" type="ColorRect" parent="Panel"]
anchor_right = 1
offset_top = 10
offset_bottom = 40
`);

test('builds the tree with paths, types and kinds', () => {
  const root = buildControlTree(NESTED);
  assert.equal(root.path, '.');
  assert.equal(root.kind, 'control');
  assert.deepEqual(root.children.map((c) => c.path), ['Panel']);
  assert.deepEqual(root.children[0].children.map((c) => c.type), ['ColorRect']);
});

test('absolute rects compose through three levels', () => {
  const layout = lay(NESTED);
  assert.deepEqual(rect(layout, '.'), { x: 0, y: 0, w: 1000, h: 600 });
  assert.deepEqual(rect(layout, 'Panel'), { x: 100, y: 50, w: 400, h: 300 });
  // Inner anchors right against the Panel's 400px width, not the viewport.
  assert.deepEqual(rect(layout, 'Panel/Inner'), { x: 100, y: 60, w: 400, h: 30 });
  assert.equal(layout.get('Panel/Inner').managed, false);
});

test('custom_minimum_size grows the rect in the grow direction', () => {
  const doc = scene(`[node name="Root" type="Control"]

[node name="A" type="Panel" parent="."]
offset_right = 10
offset_bottom = 10
custom_minimum_size = Vector2(100, 40)
grow_horizontal = 0
`);
  // grow BEGIN moves the left edge out; vertical defaults to END (grows down).
  assert.deepEqual(rect(lay(doc), 'A'), { x: -90, y: 0, w: 100, h: 40 });
});

test('VBoxContainer stacks children with separation and shares spare space', () => {
  const doc = scene(`[node name="Root" type="VBoxContainer"]
anchor_right = 1
anchor_bottom = 1

[node name="A" type="Panel" parent="."]
custom_minimum_size = Vector2(0, 100)

[node name="B" type="Panel" parent="."]
custom_minimum_size = Vector2(0, 100)
size_flags_vertical = 3
`);
  const layout = lay(doc);
  assert.ok(isContainerType('VBoxContainer'));
  // 600 total − 200 min − 4 separation = 396 spare, all to the expanding B.
  assert.deepEqual(rect(layout, 'A'), { x: 0, y: 0, w: 1000, h: 100 });
  assert.deepEqual(rect(layout, 'B'), { x: 0, y: 104, w: 1000, h: 496 });
  assert.equal(layout.get('A').managed, true);
});

test('HBoxContainer splits spare space by stretch ratio and honours shrink flags', () => {
  const doc = scene(`[node name="Root" type="HBoxContainer"]
anchor_right = 1
anchor_bottom = 1

[node name="A" type="Panel" parent="."]
size_flags_horizontal = 3
size_flags_vertical = 4
custom_minimum_size = Vector2(0, 50)

[node name="B" type="Panel" parent="."]
size_flags_horizontal = 3
size_flags_stretch_ratio = 3.0
`);
  const layout = lay(doc);
  const spare = 1000 - 4;
  assert.deepEqual(rect(layout, 'A'), { x: 0, y: 275, w: spare / 4, h: 50 });
  assert.equal(rect(layout, 'B').w, (spare * 3) / 4);
});

test('GridContainer places children by column', () => {
  const doc = scene(`[node name="Root" type="GridContainer"]
anchor_right = 1
anchor_bottom = 1
columns = 2

[node name="A" type="Panel" parent="."]
custom_minimum_size = Vector2(100, 30)

[node name="B" type="Panel" parent="."]
custom_minimum_size = Vector2(60, 30)

[node name="C" type="Panel" parent="."]
custom_minimum_size = Vector2(80, 20)
`);
  const layout = lay(doc);
  assert.deepEqual(rect(layout, 'A'), { x: 0, y: 0, w: 100, h: 30 });
  assert.deepEqual(rect(layout, 'B'), { x: 104, y: 0, w: 60, h: 30 });
  assert.deepEqual(rect(layout, 'C'), { x: 0, y: 34, w: 100, h: 20 });
});

test('MarginContainer insets by its constants; CenterContainer centres', () => {
  const doc = scene(`[node name="Root" type="MarginContainer"]
anchor_right = 1
anchor_bottom = 1
theme_override_constants/margin_left = 20
theme_override_constants/margin_top = 10
theme_override_constants/margin_right = 30
theme_override_constants/margin_bottom = 40

[node name="Center" type="CenterContainer" parent="."]

[node name="Card" type="Panel" parent="Center"]
custom_minimum_size = Vector2(200, 100)
`);
  const layout = lay(doc);
  assert.deepEqual(rect(layout, 'Center'), { x: 20, y: 10, w: 950, h: 550 });
  assert.deepEqual(rect(layout, 'Center/Card'), { x: 20 + 375, y: 10 + 225, w: 200, h: 100 });
});

test('AspectRatioContainer fits its child to the ratio', () => {
  const doc = scene(`[node name="Root" type="AspectRatioContainer"]
anchor_right = 1
anchor_bottom = 1
ratio = 1.0

[node name="Box" type="Panel" parent="."]
`);
  // 1000×600 fitted to 1:1 → 600×600 centred horizontally.
  assert.deepEqual(rect(lay(doc), 'Box'), { x: 200, y: 0, w: 600, h: 600 });
});

test('TabContainer shows only the current tab', () => {
  const doc = scene(`[node name="Root" type="TabContainer"]
anchor_right = 1
anchor_bottom = 1
current_tab = 1

[node name="One" type="Panel" parent="."]

[node name="Two" type="Panel" parent="."]
`);
  const layout = lay(doc);
  assert.equal(layout.get('One').visible, false);
  assert.equal(layout.get('Two').visible, true);
  assert.deepEqual(rect(layout, 'Two'), { x: 0, y: 31, w: 1000, h: 569 });
});

test('an unknown container leaves its children anchored and draggable', () => {
  const doc = scene(`[node name="Root" type="Control"]
anchor_right = 1
anchor_bottom = 1

[node name="Weird" type="MyCustomContainer" parent="."]
offset_right = 400
offset_bottom = 400

[node name="Kid" type="Panel" parent="Weird"]
offset_left = 5
offset_right = 55
offset_bottom = 20
`);
  const layout = lay(doc);
  assert.equal(layout.get('Weird/Kid').managed, false);
  assert.deepEqual(rect(layout, 'Weird/Kid'), { x: 5, y: 0, w: 50, h: 20 });
});

test('hidden nodes hide their subtree and drop out of picking', () => {
  const doc = scene(`[node name="Root" type="Control"]
anchor_right = 1
anchor_bottom = 1

[node name="Hidden" type="Panel" parent="."]
offset_right = 200
offset_bottom = 200
visible = false

[node name="Kid" type="ColorRect" parent="Hidden"]
offset_right = 100
offset_bottom = 100
`);
  const layout = lay(doc);
  assert.equal(layout.get('Hidden/Kid').visible, false);
  assert.equal(pickAt(layout, 50, 50), '.');
});

test('pickAt returns the topmost overlapping sibling', () => {
  const doc = scene(`[node name="Root" type="Control"]
anchor_right = 1
anchor_bottom = 1

[node name="Under" type="Panel" parent="."]
offset_right = 300
offset_bottom = 300

[node name="Over" type="Panel" parent="."]
offset_left = 100
offset_top = 100
offset_right = 400
offset_bottom = 400
`);
  const layout = lay(doc);
  assert.equal(pickAt(layout, 150, 150), 'Over');
  assert.equal(pickAt(layout, 50, 50), 'Under');
  assert.equal(pickAt(layout, 900, 500), '.');
});

test('clip_contents keeps children unpickable outside the parent', () => {
  const doc = scene(`[node name="Root" type="Control"]
anchor_right = 1
anchor_bottom = 1

[node name="Clip" type="Panel" parent="."]
offset_right = 100
offset_bottom = 100
clip_contents = true

[node name="Kid" type="ColorRect" parent="Clip"]
offset_right = 400
offset_bottom = 400
`);
  const layout = lay(doc);
  assert.equal(pickAt(layout, 50, 50), 'Clip/Kid');
  assert.equal(pickAt(layout, 250, 250), '.');
});

test('pickInRect returns fully enclosed nodes, shallowest first', () => {
  const layout = lay(NESTED);
  assert.deepEqual(pickInRect(layout, { x: 0, y: 0, w: 1000, h: 600 }), ['.', 'Panel', 'Panel/Inner']);
  assert.deepEqual(pickInRect(layout, { x: 90, y: 40, w: 420, h: 320 }), ['Panel', 'Panel/Inner']);
});

test('measure supplies the content minimum for leaf controls', () => {
  const doc = scene(`[node name="Root" type="HBoxContainer"]
anchor_right = 1
anchor_bottom = 1

[node name="Label" type="Label" parent="."]
text = "Hello"
`);
  const measure = (entry) => (entry.type === 'Label' ? { w: 64, h: 22 } : { w: 0, h: 0 });
  const root = buildControlTree(doc);
  assert.deepEqual(minimumSizeOf(root.children[0], measure), { w: 64, h: 22 });
  assert.deepEqual(minimumSizeOf(root, measure), { w: 64, h: 22 });
  // On a box's main axis only EXPAND stretches, so the label keeps its content
  // width; FILL (the default) stretches it across the cross axis.
  assert.deepEqual(rect(lay(doc, measure), 'Label'), { x: 0, y: 0, w: 64, h: 600 });
});

test('snapping nudges a rect onto sibling and viewport lines', () => {
  const layout = lay(NESTED);
  const targets = snapTargets(layout, ['Panel'], VIEW);
  assert.ok(targets.xs.includes(500));
  assert.ok(targets.ys.includes(300));
  const { rect: snapped, guides } = snapRect({ x: 97, y: 200, w: 50, h: 50 }, targets, 6);
  assert.equal(snapped.x, 100);
  assert.deepEqual(guides.xs, [100]);
  assert.equal(snapRect({ x: 60, y: 200, w: 50, h: 50 }, targets, 6).rect.x, 60);
});
