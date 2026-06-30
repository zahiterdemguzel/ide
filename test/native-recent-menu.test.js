const { test } = require('node:test');
const assert = require('node:assert/strict');
const { folderLabel, jumpListCategories, dockMenuItems } = require('../src/main/native-recent-menu');

test('folderLabel: last segment of a path (both separators)', () => {
  assert.equal(folderLabel('C:\\Users\\me\\my-app'), 'my-app');
  assert.equal(folderLabel('/home/me/my-app'), 'my-app');
  assert.equal(folderLabel('/home/me/my-app/'), 'my-app');
});

test('folderLabel: empty/non-string falls back to empty', () => {
  assert.equal(folderLabel(''), '');
  assert.equal(folderLabel(null), '');
  assert.equal(folderLabel(42), '');
});

test('jumpListCategories: builds a custom Recent category of relaunch tasks', () => {
  const cats = jumpListCategories(['/a/proj', '/b/work'], '/opt/ide');
  assert.equal(cats.length, 1);
  assert.equal(cats[0].type, 'custom');
  assert.equal(cats[0].name, 'Recent');
  assert.deepEqual(cats[0].items[0], {
    type: 'task',
    program: '/opt/ide',
    args: '--folder="/a/proj"',
    title: 'proj',
    description: '/a/proj',
  });
  assert.equal(cats[0].items[1].title, 'work');
});

test('jumpListCategories: extraArgs (dev app path) lead the relaunch args', () => {
  const cats = jumpListCategories(['/a/proj'], '/opt/electron', { extraArgs: ['"/src/app"'] });
  assert.equal(cats[0].items[0].args, '"/src/app" --folder="/a/proj"');
});

test('jumpListCategories: empty list yields no category', () => {
  assert.deepEqual(jumpListCategories([], '/opt/ide'), []);
  assert.deepEqual(jumpListCategories(undefined, '/opt/ide'), []);
});

test('jumpListCategories: drops garbage entries', () => {
  const cats = jumpListCategories(['/a', '', null, 5, '/b'], '/opt/ide');
  assert.equal(cats[0].items.length, 2);
});

test('dockMenuItems: label + folder per entry', () => {
  assert.deepEqual(dockMenuItems(['/a/proj', '/b/work']), [
    { label: 'proj', folder: '/a/proj' },
    { label: 'work', folder: '/b/work' },
  ]);
});

test('dockMenuItems: tolerates garbage and non-array input', () => {
  assert.deepEqual(dockMenuItems(['/a', '', null]), [{ label: 'a', folder: '/a' }]);
  assert.deepEqual(dockMenuItems(undefined), []);
});
