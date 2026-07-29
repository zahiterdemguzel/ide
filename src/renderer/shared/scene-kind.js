import { nodeSections, attrStr } from './tscn.js';

// Which editor a .tscn opens in. Godot has no marker for "this is a UI scene",
// so the node types decide: a Control-derived root means a UI scene, a *3D root
// means a 3D scene. The answer is computed before either editor is imported, so
// opening a UI scene never pulls in three.js.

// Every Control subclass the UI editor knows how to lay out or at least place.
// Types outside this set still work (they draw as a labelled box) — the set only
// has to be good enough to classify a scene and to offer sensible defaults.
export const CONTROL_TYPES = new Set([
  'Control',
  'Panel', 'PanelContainer', 'ColorRect', 'TextureRect', 'NinePatchRect', 'ReferenceRect',
  'Label', 'RichTextLabel', 'LinkButton',
  'BaseButton', 'Button', 'TextureButton', 'CheckBox', 'CheckButton', 'OptionButton', 'MenuButton',
  'LineEdit', 'TextEdit', 'CodeEdit', 'SpinBox',
  'Range', 'ProgressBar', 'HSlider', 'VSlider', 'HScrollBar', 'VScrollBar',
  'HSeparator', 'VSeparator',
  'Container', 'BoxContainer', 'HBoxContainer', 'VBoxContainer', 'GridContainer',
  'CenterContainer', 'MarginContainer', 'AspectRatioContainer', 'FlowContainer',
  'HFlowContainer', 'VFlowContainer', 'ScrollContainer', 'SplitContainer',
  'HSplitContainer', 'VSplitContainer', 'TabContainer', 'TabBar',
  'ItemList', 'Tree', 'GraphEdit', 'GraphNode', 'ColorPicker', 'ColorPickerButton',
  'FileDialog', 'AcceptDialog', 'ConfirmationDialog', 'Window', 'PopupMenu', 'PopupPanel',
  'VideoStreamPlayer', 'SubViewportContainer',
]);

// Node2D-family types. They live in the same 2D editor but are positioned by a
// plain `position`, not by anchors.
export const NODE2D_TYPES = new Set([
  'Node2D', 'Sprite2D', 'AnimatedSprite2D', 'Polygon2D', 'Line2D', 'TileMap', 'TileMapLayer',
  'Camera2D', 'Marker2D', 'Path2D', 'CanvasGroup', 'ParallaxBackground', 'ParallaxLayer',
  'Area2D', 'CharacterBody2D', 'RigidBody2D', 'StaticBody2D', 'CollisionShape2D',
  'CollisionPolygon2D', 'AnimationPlayer2D', 'GPUParticles2D', 'CPUParticles2D',
]);

export function isControlType(type) { return CONTROL_TYPES.has(type); }
export function isNode2DType(type) { return NODE2D_TYPES.has(type) || /2D$/.test(type || ''); }
export function is3dType(type) { return /3D$/.test(type || ''); }

// CanvasLayer holds 2D children but is itself neither Control nor Node2D.
const NEUTRAL_2D = new Set(['CanvasLayer', 'CanvasModulate']);

function kindOfType(type) {
  if (!type) return null; // instanced scenes carry no type — they vote for nothing
  if (isControlType(type)) return '2d';
  if (is3dType(type)) return '3d';
  if (isNode2DType(type) || NEUTRAL_2D.has(type)) return '2d';
  return null;
}

// The root's type decides. A generic root (`Node`, an instanced scene, a scene
// whose root is a plain container) has no opinion, so the descendants vote.
export function sceneKind(doc) {
  const nodes = nodeSections(doc);
  if (!nodes.length) return 'unknown';
  const rootKind = kindOfType(attrStr(nodes[0], 'type'));
  if (rootKind) return rootKind;
  let votes2d = 0, votes3d = 0;
  for (const n of nodes.slice(1)) {
    const k = kindOfType(attrStr(n, 'type'));
    if (k === '2d') votes2d++;
    else if (k === '3d') votes3d++;
  }
  if (!votes2d && !votes3d) return 'unknown';
  return votes2d > votes3d ? '2d' : '3d';
}
