import { test } from 'node:test';
import assert from 'node:assert/strict';
import { godotRootOf, modelEntries, nodeNameFor } from '../src/renderer/shared/scene-assets.js';
import { parseTscn, serializeTscn, addExtResource, addNode, getAttr, attrStr, nodePathOf } from '../src/renderer/shared/tscn.js';

// --- resources-panel model (shared/scene-assets.js) ---

const FILES = [
  'game/project.godot',
  'game/scenes/main.tscn',
  'game/models/robot.glb',
  'game/models/robot.png', // pre-existing thumbnail
  'game/models/tree.fbx',
  'game/models/readme.md',
  'outside/rock.glb', // outside the Godot project → not droppable
];

test('godotRootOf finds the nearest ancestor project.godot', () => {
  assert.equal(godotRootOf('game/scenes/main.tscn', FILES), 'game');
  assert.equal(godotRootOf('outside/rock.glb', FILES), null);
  assert.equal(godotRootOf('a.tscn', ['project.godot', 'a.tscn']), '');
});

test('modelEntries lists project models with res:// paths and found thumbnails only', () => {
  const entries = modelEntries('game/scenes/main.tscn', FILES);
  assert.deepEqual(entries, [
    { file: 'game/models/robot.glb', name: 'robot', thumb: 'game/models/robot.png', res: 'res://models/robot.glb' },
    { file: 'game/models/tree.fbx', name: 'tree', thumb: null, res: 'res://models/tree.fbx' },
  ]);
});

test('modelEntries falls back to the repo root when there is no project.godot', () => {
  const entries = modelEntries('scenes/main.tscn', ['scenes/main.tscn', 'assets/car.glb']);
  assert.deepEqual(entries, [
    { file: 'assets/car.glb', name: 'car', thumb: null, res: 'res://assets/car.glb' },
  ]);
});

test('nodeNameFor strips characters Godot forbids in node names', () => {
  assert.equal(nodeNameFor('robot.v2'), 'robot_v2');
  assert.equal(nodeNameFor('a@b:c%d"e/f'), 'a_b_c_d_e_f');
  assert.equal(nodeNameFor(''), 'Scene');
});

// --- the tscn ops the drop uses (shared/tscn.js) ---

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_s"]

[node name="Root" type="Node3D"]
`;

test('addExtResource inserts a PackedScene resource and keeps load_steps honest', () => {
  const doc = parseTscn(SCENE);
  const id = addExtResource(doc, { type: 'PackedScene', path: 'res://models/robot.glb' });
  assert.equal(id, '2_robot');
  assert.equal(getAttr(doc.header, 'load_steps'), '3');
  // Grouped with the other ext_resources, before the node.
  assert.deepEqual(doc.sections.map((s) => s.tag), ['ext_resource', 'ext_resource', 'node']);
  assert.match(serializeTscn(doc), /\[ext_resource type="PackedScene" path="res:\/\/models\/robot\.glb" id="2_robot"\]/);
});

test('addExtResource dedupes by type+path instead of duplicating', () => {
  const doc = parseTscn(SCENE);
  const a = addExtResource(doc, { type: 'PackedScene', path: 'res://m.glb' });
  const b = addExtResource(doc, { type: 'PackedScene', path: 'res://m.glb' });
  assert.equal(a, b);
  assert.equal(doc.sections.filter((s) => s.tag === 'ext_resource').length, 2);
  assert.equal(getAttr(doc.header, 'load_steps'), '3');
});

test('addNode with instance emits a typeless instanced-scene node', () => {
  const doc = parseTscn(SCENE);
  const id = addExtResource(doc, { type: 'PackedScene', path: 'res://models/robot.glb' });
  const node = addNode(doc, { parentPath: '.', name: 'robot', instance: `ExtResource("${id}")` });
  assert.equal(nodePathOf(node), 'robot');
  assert.equal(attrStr(node, 'type'), undefined);
  assert.match(serializeTscn(doc), /\[node name="robot" parent="\." instance=ExtResource\("2_robot"\)\]/);
});
