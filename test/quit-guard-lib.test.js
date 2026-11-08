const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isCloseWindowShortcut, isQuitShortcut, createQuitConfirmer, createCloseShortcutTracker,
} = require('../src/main/quit-guard-lib');

const keyDown = (key, mods = {}) => ({ type: 'keyDown', key, meta: false, control: false, shift: false, alt: false, ...mods });

test('isCloseWindowShortcut: Cmd+W on macOS, Ctrl+W elsewhere', () => {
  assert.equal(isCloseWindowShortcut(keyDown('w', { meta: true }), 'darwin'), true);
  assert.equal(isCloseWindowShortcut(keyDown('W', { meta: true }), 'darwin'), true);
  assert.equal(isCloseWindowShortcut(keyDown('w', { control: true }), 'win32'), true);
  assert.equal(isCloseWindowShortcut(keyDown('w', { control: true }), 'darwin'), false);
  assert.equal(isCloseWindowShortcut(keyDown('w', { meta: true }), 'linux'), false);
});

test('isCloseWindowShortcut: ignores keyUp and extra modifiers', () => {
  assert.equal(isCloseWindowShortcut({ ...keyDown('w', { meta: true }), type: 'keyUp' }, 'darwin'), false);
  assert.equal(isCloseWindowShortcut(keyDown('w', { meta: true, shift: true }), 'darwin'), false);
  assert.equal(isCloseWindowShortcut(keyDown('w', { meta: true, alt: true }), 'darwin'), false);
  assert.equal(isCloseWindowShortcut(null, 'darwin'), false);
});

test('isQuitShortcut: only Cmd+Q on macOS', () => {
  assert.equal(isQuitShortcut(keyDown('q', { meta: true }), 'darwin'), true);
  assert.equal(isQuitShortcut(keyDown('q', { meta: true, shift: true }), 'darwin'), false);
  assert.equal(isQuitShortcut(keyDown('q', { control: true }), 'win32'), false);
  assert.equal(isQuitShortcut(keyDown('q', { control: true }), 'linux'), false);
});

test('createQuitConfirmer: first press warns, second within window quits', () => {
  const confirmer = createQuitConfirmer({ windowMs: 2000 });
  assert.equal(confirmer.press(1000), 'warn');
  assert.equal(confirmer.press(2500), 'quit');
});

test('createQuitConfirmer: a press after the window expires warns again', () => {
  const confirmer = createQuitConfirmer({ windowMs: 2000 });
  assert.equal(confirmer.press(0), 'warn');
  assert.equal(confirmer.press(3000), 'warn');
  assert.equal(confirmer.press(4000), 'quit');
});

test('createQuitConfirmer: resets after quitting', () => {
  const confirmer = createQuitConfirmer({ windowMs: 2000 });
  confirmer.press(0);
  assert.equal(confirmer.press(100), 'quit');
  assert.equal(confirmer.press(200), 'warn');
});

test('createCloseShortcutTracker: blocks a close right after Cmd+W only', () => {
  const tracker = createCloseShortcutTracker({ graceMs: 1000 });
  assert.equal(tracker.shouldBlockClose(0), false);
  tracker.recordPress(5000);
  assert.equal(tracker.shouldBlockClose(5050), true);
  assert.equal(tracker.shouldBlockClose(7000), false);
});
