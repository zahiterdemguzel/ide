import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProjectGodot, projectValue, viewportSize, defaultThemeRes, DEFAULT_VIEWPORT,
} from '../src/renderer/shared/godot-project.js';

const PROJECT = `; Engine configuration file.
config_version=5

[application]

config/name="Demo"
run/main_scene="res://menu.tscn"

[display]

window/size/viewport_width=1920
window/size/viewport_height=1080

[gui]

theme/custom="res://ui/theme.tres"
`;

test('parses sections and slash-separated keys', () => {
  const cfg = parseProjectGodot(PROJECT);
  assert.equal(projectValue(cfg, 'application', 'config/name'), '"Demo"');
  assert.equal(projectValue(cfg, '', 'config_version'), '5');
  assert.equal(projectValue(cfg, 'display', 'window/size/viewport_width'), '1920');
  assert.equal(projectValue(cfg, 'missing', 'key'), undefined);
});

test('viewport size reads the display section', () => {
  assert.deepEqual(viewportSize(parseProjectGodot(PROJECT)), { width: 1920, height: 1080 });
});

test('a project without display keys gets Godot defaults', () => {
  assert.deepEqual(viewportSize(parseProjectGodot('[application]\n')), DEFAULT_VIEWPORT);
  assert.deepEqual(viewportSize(parseProjectGodot('')), DEFAULT_VIEWPORT);
  assert.deepEqual(
    viewportSize(parseProjectGodot('[display]\nwindow/size/viewport_width=nope\n')),
    DEFAULT_VIEWPORT,
  );
});

test('the project theme is unquoted, or null when unset', () => {
  assert.equal(defaultThemeRes(parseProjectGodot(PROJECT)), 'res://ui/theme.tres');
  assert.equal(defaultThemeRes(parseProjectGodot('[gui]\n')), null);
});
