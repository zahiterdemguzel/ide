import { unquote, quote, fmtNum, parseNums } from './tscn.js';

// Per-type property schemas for the UI inspector: which properties a Control
// type exposes, how to edit each one, and what Godot's default is. The default
// matters as much as the editor — Godot omits any property still at its
// default, so writing a default means *removing* the line.
//
// The schemas are hand-maintained and deliberately partial: they cover what a
// UI author reaches for. Anything present in the file but absent here still
// shows in the inspector's raw "Other" group, so nothing is ever lost.

export const KIND = {
  BOOL: 'bool', INT: 'int', FLOAT: 'float', STRING: 'string', MULTILINE: 'multiline',
  ENUM: 'enum', FLAGS: 'flags', VECTOR2: 'vector2', RECT2: 'rect2', COLOR: 'color',
  NODEPATH: 'nodepath', RESOURCE: 'resource', STYLEBOX: 'stylebox', FONT: 'font',
};

const V2 = (x, y) => ({ x, y });
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

// Godot's Control inheritance chain, only as deep as the schemas need.
export const PARENT_OF = {
  Control: 'CanvasItem',
  Panel: 'Control', ColorRect: 'Control', ReferenceRect: 'Control',
  TextureRect: 'Control', NinePatchRect: 'Control',
  Label: 'Control', RichTextLabel: 'Control',
  BaseButton: 'Control',
  Button: 'BaseButton', LinkButton: 'BaseButton', TextureButton: 'BaseButton',
  CheckBox: 'Button', CheckButton: 'Button', OptionButton: 'Button', MenuButton: 'Button',
  LineEdit: 'Control', TextEdit: 'Control', CodeEdit: 'TextEdit',
  Range: 'Control', ProgressBar: 'Range', Slider: 'Range',
  HSlider: 'Slider', VSlider: 'Slider', SpinBox: 'Range',
  HSeparator: 'Control', VSeparator: 'Control',
  ItemList: 'Control', Tree: 'Control',
  Container: 'Control',
  BoxContainer: 'Container', HBoxContainer: 'BoxContainer', VBoxContainer: 'BoxContainer',
  GridContainer: 'Container', CenterContainer: 'Container', MarginContainer: 'Container',
  PanelContainer: 'Container', AspectRatioContainer: 'Container', ScrollContainer: 'Container',
  FlowContainer: 'Container', HFlowContainer: 'FlowContainer', VFlowContainer: 'FlowContainer',
  SplitContainer: 'Container', HSplitContainer: 'SplitContainer', VSplitContainer: 'SplitContainer',
  TabContainer: 'Container', SubViewportContainer: 'Container',
  Node2D: 'CanvasItem', Sprite2D: 'Node2D',
};

const ALIGN_H = [[0, 'Left'], [1, 'Center'], [2, 'Right'], [3, 'Fill']];
const ALIGN_V = [[0, 'Top'], [1, 'Center'], [2, 'Bottom'], [3, 'Fill']];

// key, label, kind, default, extras
const p = (key, label, kind, def, extra = {}) => ({ key, label, kind, def, ...extra });

// Own properties per type, in the order the inspector shows them.
const OWN = {
  CanvasItem: [
    p('visible', 'Visible', KIND.BOOL, true, { group: 'Visibility' }),
    p('modulate', 'Modulate', KIND.COLOR, WHITE, { group: 'Visibility' }),
    p('self_modulate', 'Self Modulate', KIND.COLOR, WHITE, { group: 'Visibility' }),
    p('z_index', 'Z Index', KIND.INT, 0, { group: 'Ordering', min: -4096, max: 4096 }),
    p('z_as_relative', 'Z As Relative', KIND.BOOL, true, { group: 'Ordering' }),
  ],
  Control: [
    p('custom_minimum_size', 'Min Size', KIND.VECTOR2, V2(0, 0), { group: 'Layout' }),
    p('layout_mode', 'Layout Mode', KIND.INT, 0, { group: 'Layout', hidden: true }),
    p('size_flags_horizontal', 'H Size Flags', KIND.FLAGS, 1, { group: 'Layout', options: SIZE_FLAG_OPTIONS() }),
    p('size_flags_vertical', 'V Size Flags', KIND.FLAGS, 1, { group: 'Layout', options: SIZE_FLAG_OPTIONS() }),
    p('size_flags_stretch_ratio', 'Stretch Ratio', KIND.FLOAT, 1, { group: 'Layout', min: 0, step: 0.1 }),
    p('grow_horizontal', 'Grow Horizontal', KIND.ENUM, 1, { group: 'Layout', options: [[0, 'Begin'], [1, 'End'], [2, 'Both']] }),
    p('grow_vertical', 'Grow Vertical', KIND.ENUM, 1, { group: 'Layout', options: [[0, 'Begin'], [1, 'End'], [2, 'Both']] }),
    p('rotation', 'Rotation', KIND.FLOAT, 0, { group: 'Transform', step: 0.01 }),
    p('scale', 'Scale', KIND.VECTOR2, V2(1, 1), { group: 'Transform' }),
    p('pivot_offset', 'Pivot Offset', KIND.VECTOR2, V2(0, 0), { group: 'Transform' }),
    p('clip_contents', 'Clip Contents', KIND.BOOL, false, { group: 'Visibility' }),
    p('tooltip_text', 'Tooltip', KIND.STRING, '', { group: 'Mouse' }),
    p('mouse_filter', 'Mouse Filter', KIND.ENUM, 0, { group: 'Mouse', options: [[0, 'Stop'], [1, 'Pass'], [2, 'Ignore']] }),
    p('mouse_default_cursor_shape', 'Cursor', KIND.INT, 0, { group: 'Mouse' }),
    p('focus_mode', 'Focus Mode', KIND.ENUM, 0, { group: 'Focus', options: [[0, 'None'], [1, 'Click'], [2, 'All']] }),
    p('theme', 'Theme', KIND.RESOURCE, null, { group: 'Theme', resourceType: 'Theme' }),
    p('theme_type_variation', 'Type Variation', KIND.STRING, '', { group: 'Theme' }),
  ],
  Panel: [],
  PanelContainer: [],
  ColorRect: [p('color', 'Color', KIND.COLOR, WHITE, { group: 'ColorRect' })],
  TextureRect: [
    p('texture', 'Texture', KIND.RESOURCE, null, { group: 'TextureRect', resourceType: 'Texture2D' }),
    p('expand_mode', 'Expand Mode', KIND.ENUM, 0, { group: 'TextureRect', options: [[0, 'Keep Size'], [1, 'Ignore Size'], [2, 'Fit Width'], [3, 'Fit Width Proportional'], [4, 'Fit Height'], [5, 'Fit Height Proportional']] }),
    p('stretch_mode', 'Stretch Mode', KIND.ENUM, 0, { group: 'TextureRect', options: [[0, 'Scale'], [1, 'Tile'], [2, 'Keep'], [3, 'Keep Centered'], [4, 'Keep Aspect'], [5, 'Keep Aspect Centered'], [6, 'Keep Aspect Covered']] }),
    p('flip_h', 'Flip H', KIND.BOOL, false, { group: 'TextureRect' }),
    p('flip_v', 'Flip V', KIND.BOOL, false, { group: 'TextureRect' }),
  ],
  NinePatchRect: [
    p('texture', 'Texture', KIND.RESOURCE, null, { group: 'NinePatchRect', resourceType: 'Texture2D' }),
    p('draw_center', 'Draw Center', KIND.BOOL, true, { group: 'NinePatchRect' }),
    p('patch_margin_left', 'Patch Left', KIND.INT, 0, { group: 'Patch Margin' }),
    p('patch_margin_top', 'Patch Top', KIND.INT, 0, { group: 'Patch Margin' }),
    p('patch_margin_right', 'Patch Right', KIND.INT, 0, { group: 'Patch Margin' }),
    p('patch_margin_bottom', 'Patch Bottom', KIND.INT, 0, { group: 'Patch Margin' }),
    p('axis_stretch_horizontal', 'Axis Stretch H', KIND.ENUM, 0, { group: 'Patch Margin', options: [[0, 'Stretch'], [1, 'Tile'], [2, 'Tile Fit']] }),
    p('axis_stretch_vertical', 'Axis Stretch V', KIND.ENUM, 0, { group: 'Patch Margin', options: [[0, 'Stretch'], [1, 'Tile'], [2, 'Tile Fit']] }),
  ],
  Label: [
    p('text', 'Text', KIND.MULTILINE, '', { group: 'Label' }),
    p('horizontal_alignment', 'H Align', KIND.ENUM, 0, { group: 'Label', options: ALIGN_H }),
    p('vertical_alignment', 'V Align', KIND.ENUM, 0, { group: 'Label', options: ALIGN_V }),
    p('autowrap_mode', 'Autowrap', KIND.ENUM, 0, { group: 'Label', options: [[0, 'Off'], [1, 'Arbitrary'], [2, 'Word'], [3, 'Word (Smart)']] }),
    p('clip_text', 'Clip Text', KIND.BOOL, false, { group: 'Label' }),
    p('uppercase', 'Uppercase', KIND.BOOL, false, { group: 'Label' }),
    p('max_lines_visible', 'Max Lines', KIND.INT, -1, { group: 'Label' }),
  ],
  RichTextLabel: [
    p('text', 'Text', KIND.MULTILINE, '', { group: 'RichTextLabel' }),
    p('bbcode_enabled', 'BBCode Enabled', KIND.BOOL, false, { group: 'RichTextLabel' }),
    p('fit_content', 'Fit Content', KIND.BOOL, false, { group: 'RichTextLabel' }),
    p('scroll_active', 'Scroll Active', KIND.BOOL, true, { group: 'RichTextLabel' }),
    p('selection_enabled', 'Selection Enabled', KIND.BOOL, false, { group: 'RichTextLabel' }),
  ],
  BaseButton: [
    p('disabled', 'Disabled', KIND.BOOL, false, { group: 'Button' }),
    p('toggle_mode', 'Toggle Mode', KIND.BOOL, false, { group: 'Button' }),
    p('button_pressed', 'Pressed', KIND.BOOL, false, { group: 'Button' }),
    p('action_mode', 'Action Mode', KIND.ENUM, 1, { group: 'Button', options: [[0, 'Press'], [1, 'Release']] }),
    p('keep_pressed_outside', 'Keep Pressed Outside', KIND.BOOL, false, { group: 'Button' }),
  ],
  Button: [
    p('text', 'Text', KIND.STRING, '', { group: 'Button' }),
    p('icon', 'Icon', KIND.RESOURCE, null, { group: 'Button', resourceType: 'Texture2D' }),
    p('flat', 'Flat', KIND.BOOL, false, { group: 'Button' }),
    p('alignment', 'Alignment', KIND.ENUM, 1, { group: 'Button', options: ALIGN_H }),
    p('expand_icon', 'Expand Icon', KIND.BOOL, false, { group: 'Button' }),
    p('clip_text', 'Clip Text', KIND.BOOL, false, { group: 'Button' }),
  ],
  LinkButton: [
    p('text', 'Text', KIND.STRING, '', { group: 'Button' }),
    p('underline', 'Underline', KIND.ENUM, 0, { group: 'Button', options: [[0, 'Always'], [1, 'On Hover'], [2, 'Never']] }),
  ],
  TextureButton: [
    p('texture_normal', 'Normal', KIND.RESOURCE, null, { group: 'Textures', resourceType: 'Texture2D' }),
    p('texture_pressed', 'Pressed', KIND.RESOURCE, null, { group: 'Textures', resourceType: 'Texture2D' }),
    p('texture_hover', 'Hover', KIND.RESOURCE, null, { group: 'Textures', resourceType: 'Texture2D' }),
    p('texture_disabled', 'Disabled', KIND.RESOURCE, null, { group: 'Textures', resourceType: 'Texture2D' }),
    p('ignore_texture_size', 'Ignore Texture Size', KIND.BOOL, false, { group: 'Textures' }),
    p('stretch_mode', 'Stretch Mode', KIND.ENUM, 2, { group: 'Textures', options: [[0, 'Scale'], [1, 'Tile'], [2, 'Keep'], [3, 'Keep Centered'], [4, 'Keep Aspect'], [5, 'Keep Aspect Centered'], [6, 'Keep Aspect Covered']] }),
  ],
  OptionButton: [p('selected', 'Selected', KIND.INT, -1, { group: 'Button' })],
  LineEdit: [
    p('text', 'Text', KIND.STRING, '', { group: 'LineEdit' }),
    p('placeholder_text', 'Placeholder', KIND.STRING, '', { group: 'LineEdit' }),
    p('alignment', 'Alignment', KIND.ENUM, 0, { group: 'LineEdit', options: ALIGN_H }),
    p('max_length', 'Max Length', KIND.INT, 0, { group: 'LineEdit', min: 0 }),
    p('editable', 'Editable', KIND.BOOL, true, { group: 'LineEdit' }),
    p('secret', 'Secret', KIND.BOOL, false, { group: 'LineEdit' }),
    p('expand_to_text_length', 'Expand To Text', KIND.BOOL, false, { group: 'LineEdit' }),
  ],
  TextEdit: [
    p('text', 'Text', KIND.MULTILINE, '', { group: 'TextEdit' }),
    p('placeholder_text', 'Placeholder', KIND.STRING, '', { group: 'TextEdit' }),
    p('editable', 'Editable', KIND.BOOL, true, { group: 'TextEdit' }),
    p('wrap_mode', 'Wrap Mode', KIND.ENUM, 0, { group: 'TextEdit', options: [[0, 'None'], [1, 'Boundary']] }),
    p('scroll_smooth', 'Smooth Scroll', KIND.BOOL, false, { group: 'TextEdit' }),
  ],
  Range: [
    p('min_value', 'Min', KIND.FLOAT, 0, { group: 'Range' }),
    p('max_value', 'Max', KIND.FLOAT, 100, { group: 'Range' }),
    p('step', 'Step', KIND.FLOAT, 1, { group: 'Range' }),
    p('value', 'Value', KIND.FLOAT, 0, { group: 'Range' }),
    p('allow_greater', 'Allow Greater', KIND.BOOL, false, { group: 'Range' }),
    p('allow_lesser', 'Allow Lesser', KIND.BOOL, false, { group: 'Range' }),
    p('exp_edit', 'Exponential', KIND.BOOL, false, { group: 'Range' }),
    p('rounded', 'Rounded', KIND.BOOL, false, { group: 'Range' }),
  ],
  ProgressBar: [
    p('show_percentage', 'Show Percentage', KIND.BOOL, true, { group: 'ProgressBar' }),
    p('fill_mode', 'Fill Mode', KIND.ENUM, 0, { group: 'ProgressBar', options: [[0, 'Begin To End'], [1, 'End To Begin'], [2, 'Top To Bottom'], [3, 'Bottom To Top']] }),
  ],
  Slider: [
    p('editable', 'Editable', KIND.BOOL, true, { group: 'Slider' }),
    p('scrollable', 'Scrollable', KIND.BOOL, true, { group: 'Slider' }),
    p('tick_count', 'Tick Count', KIND.INT, 0, { group: 'Slider', min: 0 }),
    p('ticks_on_borders', 'Ticks On Borders', KIND.BOOL, false, { group: 'Slider' }),
  ],
  BoxContainer: [
    p('alignment', 'Alignment', KIND.ENUM, 0, { group: 'Container', options: [[0, 'Begin'], [1, 'Center'], [2, 'End']] }),
    p('vertical', 'Vertical', KIND.BOOL, false, { group: 'Container' }),
  ],
  GridContainer: [p('columns', 'Columns', KIND.INT, 1, { group: 'Container', min: 1 })],
  AspectRatioContainer: [
    p('ratio', 'Ratio', KIND.FLOAT, 1, { group: 'Container', min: 0.01, step: 0.05 }),
    p('stretch_mode', 'Stretch Mode', KIND.ENUM, 2, { group: 'Container', options: [[0, 'Width Controls Height'], [1, 'Height Controls Width'], [2, 'Fit'], [3, 'Cover']] }),
    p('alignment_horizontal', 'H Alignment', KIND.ENUM, 1, { group: 'Container', options: [[0, 'Begin'], [1, 'Center'], [2, 'End']] }),
    p('alignment_vertical', 'V Alignment', KIND.ENUM, 1, { group: 'Container', options: [[0, 'Begin'], [1, 'Center'], [2, 'End']] }),
  ],
  ScrollContainer: [
    p('horizontal_scroll_mode', 'H Scroll', KIND.ENUM, 1, { group: 'Container', options: [[0, 'Disabled'], [1, 'Auto'], [2, 'Always Show'], [3, 'Never Show'], [4, 'Shrink Begin'], [5, 'Shrink End']] }),
    p('vertical_scroll_mode', 'V Scroll', KIND.ENUM, 1, { group: 'Container', options: [[0, 'Disabled'], [1, 'Auto'], [2, 'Always Show'], [3, 'Never Show'], [4, 'Shrink Begin'], [5, 'Shrink End']] }),
    p('follow_focus', 'Follow Focus', KIND.BOOL, false, { group: 'Container' }),
  ],
  SplitContainer: [
    p('split_offset', 'Split Offset', KIND.INT, 0, { group: 'Container' }),
    p('collapsed', 'Collapsed', KIND.BOOL, false, { group: 'Container' }),
    p('dragger_visibility', 'Dragger', KIND.ENUM, 0, { group: 'Container', options: [[0, 'Visible'], [1, 'Hidden'], [2, 'Hidden & Collapsed']] }),
  ],
  TabContainer: [
    p('current_tab', 'Current Tab', KIND.INT, 0, { group: 'Container', min: 0 }),
    p('tabs_visible', 'Tabs Visible', KIND.BOOL, true, { group: 'Container' }),
    p('clip_tabs', 'Clip Tabs', KIND.BOOL, true, { group: 'Container' }),
    p('tab_alignment', 'Tab Alignment', KIND.ENUM, 0, { group: 'Container', options: [[0, 'Left'], [1, 'Center'], [2, 'Right']] }),
  ],
  FlowContainer: [p('vertical', 'Vertical', KIND.BOOL, false, { group: 'Container' })],
  Node2D: [
    p('position', 'Position', KIND.VECTOR2, V2(0, 0), { group: 'Transform' }),
    p('rotation', 'Rotation', KIND.FLOAT, 0, { group: 'Transform', step: 0.01 }),
    p('scale', 'Scale', KIND.VECTOR2, V2(1, 1), { group: 'Transform' }),
    p('skew', 'Skew', KIND.FLOAT, 0, { group: 'Transform', step: 0.01 }),
  ],
  Sprite2D: [
    p('texture', 'Texture', KIND.RESOURCE, null, { group: 'Sprite2D', resourceType: 'Texture2D' }),
    p('centered', 'Centered', KIND.BOOL, true, { group: 'Sprite2D' }),
    p('offset', 'Offset', KIND.VECTOR2, V2(0, 0), { group: 'Sprite2D' }),
    p('flip_h', 'Flip H', KIND.BOOL, false, { group: 'Sprite2D' }),
    p('flip_v', 'Flip V', KIND.BOOL, false, { group: 'Sprite2D' }),
  ],
};

function SIZE_FLAG_OPTIONS() {
  return [[1, 'Fill'], [2, 'Expand'], [4, 'Shrink Center'], [8, 'Shrink End']];
}

// The anchor/offset properties the Layout section owns; the generic property
// list hides them so they are edited in one place.
export const LAYOUT_RECT_KEYS = new Set([
  'anchor_left', 'anchor_top', 'anchor_right', 'anchor_bottom',
  'offset_left', 'offset_top', 'offset_right', 'offset_bottom',
  'anchors_preset', 'layout_mode',
]);

const chainOf = (type) => {
  const out = [];
  for (let t = type; t; t = PARENT_OF[t]) { out.unshift(t); if (out.length > 12) break; }
  return out;
};

const schemaCache = new Map();

// Every property `type` exposes, deduped along the inheritance chain (a
// subclass redefining a default wins) and bucketed into display groups.
export function schemaFor(type) {
  if (schemaCache.has(type)) return schemaCache.get(type);
  const byKey = new Map();
  for (const t of chainOf(type)) for (const spec of OWN[t] || []) byKey.set(spec.key, spec);
  const groups = [];
  for (const spec of byKey.values()) {
    if (spec.hidden) continue;
    let g = groups.find((x) => x.name === (spec.group || 'Other'));
    if (!g) { g = { name: spec.group || 'Other', props: [] }; groups.push(g); }
    g.props.push(spec);
  }
  const schema = { type, groups, byKey };
  schemaCache.set(type, schema);
  return schema;
}

export function specFor(type, key) { return schemaFor(type).byKey.get(key) || null; }
export function defaultOf(type, key) { const s = specFor(type, key); return s ? s.def : undefined; }

// --- theme overrides --------------------------------------------------------
// Godot's theme items are not real properties; they are free-form keys under
// `theme_override_<bucket>/<name>`. These are the names worth offering per type.

const COMMON_TEXT = { colors: ['font_color', 'font_shadow_color', 'font_outline_color'], font_sizes: ['font_size'], fonts: ['font'] };
const BUTTON_ITEMS = {
  colors: ['font_color', 'font_pressed_color', 'font_hover_color', 'font_disabled_color', 'font_focus_color', 'icon_normal_color'],
  font_sizes: ['font_size'], fonts: ['font'],
  constants: ['h_separation', 'outline_size'],
  styles: ['normal', 'hover', 'pressed', 'disabled', 'focus'],
};

const THEME_ITEMS = {
  Control: { colors: [], fonts: [], font_sizes: [], constants: [], styles: [] },
  Label: { ...COMMON_TEXT, constants: ['line_spacing', 'outline_size', 'shadow_offset_x', 'shadow_offset_y'], styles: ['normal'] },
  RichTextLabel: { ...COMMON_TEXT, constants: ['line_separation', 'outline_size'], styles: ['normal', 'focus'] },
  Panel: { colors: [], fonts: [], font_sizes: [], constants: [], styles: ['panel'] },
  PanelContainer: { colors: [], fonts: [], font_sizes: [], constants: [], styles: ['panel'] },
  Button: BUTTON_ITEMS, CheckBox: BUTTON_ITEMS, CheckButton: BUTTON_ITEMS,
  OptionButton: BUTTON_ITEMS, MenuButton: BUTTON_ITEMS, LinkButton: BUTTON_ITEMS,
  LineEdit: { colors: ['font_color', 'font_placeholder_color', 'caret_color', 'selection_color'], fonts: ['font'], font_sizes: ['font_size'], constants: ['minimum_character_width'], styles: ['normal', 'focus', 'read_only'] },
  TextEdit: { colors: ['font_color', 'font_placeholder_color', 'caret_color', 'selection_color'], fonts: ['font'], font_sizes: ['font_size'], constants: ['line_spacing'], styles: ['normal', 'focus', 'read_only'] },
  ProgressBar: { colors: ['font_color'], fonts: ['font'], font_sizes: ['font_size'], constants: [], styles: ['background', 'fill'] },
  BoxContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation'], styles: [] },
  HBoxContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation'], styles: [] },
  VBoxContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation'], styles: [] },
  GridContainer: { colors: [], fonts: [], font_sizes: [], constants: ['h_separation', 'v_separation'], styles: [] },
  MarginContainer: { colors: [], fonts: [], font_sizes: [], constants: ['margin_left', 'margin_top', 'margin_right', 'margin_bottom'], styles: [] },
  SplitContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation', 'minimum_grab_thickness'], styles: [] },
  HSplitContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation'], styles: [] },
  VSplitContainer: { colors: [], fonts: [], font_sizes: [], constants: ['separation'], styles: [] },
  TabContainer: { colors: ['font_selected_color', 'font_unselected_color'], fonts: ['font'], font_sizes: ['font_size'], constants: ['side_margin'], styles: ['panel', 'tab_selected', 'tab_unselected', 'tabbar_background'] },
};

const EMPTY_ITEMS = { colors: [], fonts: [], font_sizes: [], constants: [], styles: [] };

// The theme item names offered for a type, merged along its chain.
export function themeOverridesFor(type) {
  const out = { colors: [], fonts: [], font_sizes: [], constants: [], styles: [] };
  for (const t of chainOf(type)) {
    const items = THEME_ITEMS[t] || EMPTY_ITEMS;
    for (const bucket of Object.keys(out)) {
      for (const name of items[bucket] || []) if (!out[bucket].includes(name)) out[bucket].push(name);
    }
  }
  return out;
}

// The value kind a theme bucket edits.
export const THEME_BUCKET_KIND = {
  colors: KIND.COLOR, fonts: KIND.FONT, font_sizes: KIND.INT,
  constants: KIND.INT, styles: KIND.STYLEBOX,
};

// --- value ⇄ raw text -------------------------------------------------------

export function parseValue(kind, raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  const n = parseNums(s);
  switch (kind) {
    case KIND.BOOL: return s === 'true';
    case KIND.INT: case KIND.ENUM: case KIND.FLAGS: return Number.isFinite(Number(s)) ? Number(s) : 0;
    case KIND.FLOAT: return Number.isFinite(Number(s)) ? Number(s) : 0;
    // Godot keeps real newlines inside the quotes (the parser joins the lines),
    // so only the quote/backslash escapes need undoing.
    case KIND.STRING: case KIND.MULTILINE: return unquote(s);
    case KIND.VECTOR2: return { x: n[0] ?? 0, y: n[1] ?? 0 };
    case KIND.RECT2: return { x: n[0] ?? 0, y: n[1] ?? 0, w: n[2] ?? 0, h: n[3] ?? 0 };
    case KIND.COLOR: return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 1 };
    case KIND.NODEPATH: {
      const m = /^NodePath\((.*)\)$/.exec(s);
      return m ? unquote(m[1].trim()) : unquote(s);
    }
    default: return s; // RESOURCE / STYLEBOX / FONT keep their raw reference
  }
}

export function formatValue(kind, value) {
  switch (kind) {
    case KIND.BOOL: return value ? 'true' : 'false';
    case KIND.INT: case KIND.ENUM: case KIND.FLAGS: return String(Math.round(Number(value) || 0));
    case KIND.FLOAT: return fmtNum(Number(value) || 0);
    case KIND.STRING: case KIND.MULTILINE: return quote(String(value ?? ''));
    case KIND.VECTOR2: return `Vector2(${fmtNum(value.x || 0)}, ${fmtNum(value.y || 0)})`;
    case KIND.RECT2: return `Rect2(${[value.x, value.y, value.w, value.h].map((v) => fmtNum(v || 0)).join(', ')})`;
    case KIND.COLOR: return `Color(${[value.r, value.g, value.b, value.a ?? 1].map((v) => fmtNum(v || 0)).join(', ')})`;
    case KIND.NODEPATH: return `NodePath(${quote(String(value ?? ''))})`;
    default: return value === null || value === undefined ? '' : String(value);
  }
}

const EPS = 1e-6;
const closeTo = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < EPS;

export function valuesEqual(kind, a, b) {
  if (a === b) return true;
  switch (kind) {
    case KIND.FLOAT: case KIND.INT: case KIND.ENUM: case KIND.FLAGS: return closeTo(a, b);
    case KIND.BOOL: return !!a === !!b;
    case KIND.VECTOR2: return !!a && !!b && closeTo(a.x, b.x) && closeTo(a.y, b.y);
    case KIND.RECT2: return !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => closeTo(a[k], b[k]));
    case KIND.COLOR:
      return !!a && !!b && ['r', 'g', 'b'].every((k) => closeTo(a[k], b[k])) && closeTo(a.a ?? 1, b.a ?? 1);
    case KIND.STRING: case KIND.MULTILINE: return String(a ?? '') === String(b ?? '');
    default: return (a ?? null) === (b ?? null);
  }
}
