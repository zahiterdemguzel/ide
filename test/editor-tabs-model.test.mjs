import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTabs, openTab, pinTab, activateTab, closeTab, filesToRight, otherFiles,
  moveTab, renameTab, neighborTab, addBackgroundTab,
} from '../src/renderer/editor/tabs-model.js';

const files = (s) => s.tabs.map((t) => t.file);

test('openTab: new tabs open right of the active one', () => {
  let s = openTab(emptyTabs(), 'a');
  s = openTab(s, 'b');
  s = activateTab(s, 'a');
  s = openTab(s, 'c');
  assert.deepEqual(files(s), ['a', 'c', 'b']);
  assert.equal(s.active, 'c');
});

test('openTab: a preview open replaces the previous preview tab in place', () => {
  let s = openTab(emptyTabs(), 'a');
  s = openTab(s, 'p1', { preview: true });
  s = openTab(s, 'p2', { preview: true });
  assert.deepEqual(files(s), ['a', 'p2']);
  assert.equal(s.tabs[1].preview, true);
  assert.ok(!s.mru.includes('p1'));
});

test('openTab: re-opening a preview tab pinned pins it; pinTab does the same', () => {
  let s = openTab(emptyTabs(), 'p', { preview: true });
  s = openTab(s, 'p');
  assert.equal(s.tabs[0].preview, false);
  let t = openTab(emptyTabs(), 'q', { preview: true });
  t = pinTab(t, 'q');
  assert.equal(t.tabs[0].preview, false);
  t = openTab(t, 'r', { preview: true });
  assert.deepEqual(files(t), ['q', 'r']); // the pinned tab is never replaced
});

test('closeTab: activates the most recently used remaining tab', () => {
  let s = openTab(emptyTabs(), 'a');
  s = openTab(s, 'b');
  s = openTab(s, 'c');
  s = activateTab(s, 'a');
  s = activateTab(s, 'c');
  s = closeTab(s, 'c');
  assert.equal(s.active, 'a');
  s = closeTab(closeTab(s, 'a'), 'b');
  assert.equal(s.active, null);
  assert.deepEqual(s.tabs, []);
});

test('filesToRight / otherFiles feed the tab context menu', () => {
  let s = emptyTabs();
  for (const f of ['a', 'b', 'c', 'd']) s = openTab(s, f);
  assert.deepEqual(filesToRight(s, 'b'), ['c', 'd']);
  assert.deepEqual(otherFiles(s, 'b'), ['a', 'c', 'd']);
});

test('moveTab / renameTab / neighborTab', () => {
  let s = emptyTabs();
  for (const f of ['a', 'b', 'c']) s = openTab(s, f);
  s = moveTab(s, 'c', 0);
  assert.deepEqual(files(s), ['c', 'a', 'b']);
  s = renameTab(s, 'a', 'z');
  assert.deepEqual(files(s), ['c', 'z', 'b']);
  assert.equal(s.active, 'c');
  assert.equal(neighborTab(s, 1), 'z');
  assert.equal(neighborTab(s, -1), 'b');
});

test('addBackgroundTab: appends a pinned tab without switching to it', () => {
  let s = openTab(emptyTabs(), 'a');
  s = openTab(s, 'b', { preview: true });
  s = addBackgroundTab(s, 'c');
  assert.deepEqual(s.tabs, [{ file: 'a', preview: false }, { file: 'b', preview: true }, { file: 'c', preview: false }]);
  assert.equal(s.active, 'b');
  assert.deepEqual(s.mru, ['b', 'a', 'c']);
  assert.equal(addBackgroundTab(s, 'a'), s); // already open: unchanged
  assert.equal(addBackgroundTab(emptyTabs(), 'x').active, 'x'); // first tab becomes active
});
