import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn } from '../src/renderer/shared/tscn.js';
import { sceneKind, isControlType, isNode2DType } from '../src/renderer/shared/scene-kind.js';

const scene = (body) => parseTscn(`[gd_scene format=3]\n\n${body}`);

test('a Control root is a 2D scene', () => {
  assert.equal(sceneKind(scene('[node name="Menu" type="Control"]\n')), '2d');
  assert.equal(sceneKind(scene('[node name="Menu" type="PanelContainer"]\n')), '2d');
});

test('a 3D root is a 3D scene even with a Control branch', () => {
  const doc = scene(`[node name="Root" type="Node3D"]

[node name="UI" type="Control" parent="."]
`);
  assert.equal(sceneKind(doc), '3d');
});

test('a generic root falls back to a vote over its descendants', () => {
  const ui = scene(`[node name="Root" type="Node"]

[node name="Layer" type="CanvasLayer" parent="."]

[node name="Label" type="Label" parent="Layer"]
`);
  assert.equal(sceneKind(ui), '2d');

  const world = scene(`[node name="Root" type="Node"]

[node name="Mesh" type="MeshInstance3D" parent="."]

[node name="Light" type="OmniLight3D" parent="."]
`);
  assert.equal(sceneKind(world), '3d');
});

test('an unclassifiable or empty scene is unknown', () => {
  assert.equal(sceneKind(scene('[node name="Root" type="Node"]\n')), 'unknown');
  assert.equal(sceneKind(parseTscn('[gd_scene format=3]\n')), 'unknown');
});

test('type predicates cover the families the editor draws', () => {
  assert.ok(isControlType('VBoxContainer'));
  assert.ok(isControlType('TextureRect'));
  assert.ok(!isControlType('Node3D'));
  assert.ok(isNode2DType('Sprite2D'));
  assert.ok(isNode2DType('CharacterBody2D'));
  assert.ok(!isNode2DType('Label'));
});
