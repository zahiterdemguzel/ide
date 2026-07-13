import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTscn, serializeTscn, nodeSections, nodePathOf, findNode, attrStr, getAttr,
  getProp, parseNums, parseRef, fmtNum, unquote, quote,
  transformOfNode, setNodeTransform, serializeTransform3d, IDENTITY_TRANSFORM,
  addNode, removeNodeTree, addSubResource, uniqueChildName,
} from '../src/renderer/shared/tscn.js';

// A small but representative scene, written in the canonical layout the
// serializer produces so parse → serialize round-trips to the same text.
const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://abc123"]

[ext_resource type="Script" path="res://player.gd" id="1_s"]

[sub_resource type="BoxMesh" id="BoxMesh_1"]
size = Vector3(2, 1, 1)

[node name="Root" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0)
script = ExtResource("1_s")

[node name="Mesh" type="MeshInstance3D" parent="Player"]
mesh = SubResource("BoxMesh_1")

[node name="UI" type="Control" parent="."]

[connection signal="ready" from="Player" to="." method="_on_ready"]
`;

test('parses the descriptor, sections, and node paths', () => {
  const doc = parseTscn(SCENE);
  assert.equal(doc.header.tag, 'gd_scene');
  assert.equal(getAttr(doc.header, 'load_steps'), '3');
  assert.equal(attrStr(doc.header, 'uid'), 'uid://abc123');
  assert.deepEqual(doc.sections.map((s) => s.tag),
    ['ext_resource', 'sub_resource', 'node', 'node', 'node', 'node', 'connection']);
  assert.deepEqual(nodeSections(doc).map(nodePathOf), ['.', 'Player', 'Player/Mesh', 'UI']);
  assert.equal(getProp(findNode(doc, 'Player'), 'script'), 'ExtResource("1_s")');
});

test('serialize round-trips the parsed scene text', () => {
  assert.equal(serializeTscn(parseTscn(SCENE)), SCENE);
});

test('adjacent ext_resources stay adjacent; multi-line values survive', () => {
  const text = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://a.gd" id="1_a"]
[ext_resource type="Script" path="res://b.gd" id="2_b"]

[node name="Root" type="Node3D"]
metadata/_custom = {
"key": [1, 2, 3],
"other": "va]ue"
}
`;
  const doc = parseTscn(text);
  const root = findNode(doc, '.');
  assert.match(getProp(root, 'metadata/_custom'), /"key": \[1, 2, 3\]/);
  assert.equal(serializeTscn(doc), text);
});

test('quote/unquote and parseRef handle escapes and both ref kinds', () => {
  assert.equal(unquote('"a \\"b\\" c"'), 'a "b" c');
  assert.equal(quote('a "b"'), '"a \\"b\\""');
  assert.deepEqual(parseRef('SubResource("BoxMesh_1")'), { kind: 'sub', id: 'BoxMesh_1' });
  assert.deepEqual(parseRef('ExtResource("2_y")'), { kind: 'ext', id: '2_y' });
  assert.equal(parseRef('Vector3(1, 2, 3)'), null);
});

test('fmtNum matches Godot-style number formatting', () => {
  assert.equal(fmtNum(1), '1');
  assert.equal(fmtNum(-0), '0');
  assert.equal(fmtNum(0.5), '0.5');
  assert.equal(fmtNum(1e-8), '0'); // float noise collapses to zero
  assert.equal(fmtNum(1.0000000001), '1');
  assert.equal(fmtNum(-2.25), '-2.25');
});

test('transformOfNode reads a full Transform3D', () => {
  const doc = parseTscn(SCENE);
  assert.deepEqual(transformOfNode(findNode(doc, 'Player')),
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0]);
  // A node with no transform data at all → identity.
  assert.deepEqual(transformOfNode(findNode(doc, 'UI')), IDENTITY_TRANSFORM);
});

test('transformOfNode composes position/rotation/scale (Euler YXZ)', () => {
  const doc = parseTscn(`[gd_scene format=3]

[node name="Root" type="Node3D"]
position = Vector3(1, 2, 3)
rotation = Vector3(0, ${Math.PI / 2}, 0)
scale = Vector3(2, 2, 2)
`);
  const t = transformOfNode(findNode(doc, '.'));
  // +90° yaw: basis columns map x → -z; each column scaled by 2.
  const expected = [0, 0, 2, 0, 2, 0, -2, 0, 0, 1, 2, 3];
  for (let i = 0; i < 12; i++) assert.ok(Math.abs(t[i] - expected[i]) < 1e-9, `t[${i}] = ${t[i]}`);
});

test('setNodeTransform replaces split TRS props with one leading transform', () => {
  const doc = parseTscn(`[gd_scene format=3]

[node name="Root" type="Node3D"]

[node name="A" type="Node3D" parent="."]
position = Vector3(1, 0, 0)
rotation = Vector3(0, 1, 0)
visible = false
`);
  setNodeTransform(doc, 'A', [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
  const a = findNode(doc, 'A');
  assert.equal(getProp(a, 'position'), undefined);
  assert.equal(getProp(a, 'rotation'), undefined);
  assert.equal(a.props[0].key, 'transform');
  assert.equal(a.props[0].value, 'Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7)');
  assert.equal(getProp(a, 'visible'), 'false'); // untouched props survive
});

test('serializeTransform3d formats via fmtNum', () => {
  assert.equal(serializeTransform3d([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, -0, 1e-9]),
    'Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0)');
});

test('addNode appends after the parent subtree, keeping depth-first order', () => {
  const doc = parseTscn(SCENE);
  const node = addNode(doc, { parentPath: 'Player', type: 'Node3D', name: 'Arm' });
  assert.equal(nodePathOf(node), 'Player/Arm');
  // New node lands after Player/Mesh (the parent's last descendant), before UI.
  assert.deepEqual(nodeSections(doc).map(nodePathOf), ['.', 'Player', 'Player/Mesh', 'Player/Arm', 'UI']);
  assert.match(serializeTscn(doc), /\[node name="Arm" type="Node3D" parent="Player"\]/);
});

test('uniqueChildName numbers collisions like Godot', () => {
  const doc = parseTscn(SCENE);
  assert.equal(uniqueChildName(doc, 'Player', 'Mesh'), 'Mesh2');
  assert.equal(uniqueChildName(doc, 'Player', 'Box'), 'Box');
  assert.equal(uniqueChildName(doc, '.', 'Player'), 'Player2');
});

test('removeNodeTree drops the subtree and its connections', () => {
  const doc = parseTscn(SCENE);
  removeNodeTree(doc, 'Player');
  assert.deepEqual(nodeSections(doc).map(nodePathOf), ['.', 'UI']);
  assert.ok(!doc.sections.some((s) => s.tag === 'connection'), 'connection into the subtree removed');
  assert.throws(() => removeNodeTree(doc, '.'));
});

test('addSubResource makes a unique id and keeps load_steps honest', () => {
  const doc = parseTscn(SCENE);
  const id = addSubResource(doc, 'BoxMesh', [{ key: 'size', value: 'Vector3(1, 1, 1)' }]);
  assert.equal(id, 'BoxMesh_2'); // BoxMesh_1 exists
  assert.equal(getAttr(doc.header, 'load_steps'), '4');
  // Grouped with the other resources, before the first node.
  const tags = doc.sections.map((s) => s.tag);
  assert.deepEqual(tags.slice(0, 3), ['ext_resource', 'sub_resource', 'sub_resource']);
  const sphereId = addSubResource(doc, 'SphereMesh');
  assert.equal(sphereId, 'SphereMesh_1');
  assert.equal(getAttr(doc.header, 'load_steps'), '5');
});

test('parseNums pulls every number out of constructor values', () => {
  assert.deepEqual(parseNums('Vector3(1, -2.5, 3e-2)'), [1, -2.5, 0.03]);
  assert.deepEqual(parseNums('Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)').length, 12);
});
