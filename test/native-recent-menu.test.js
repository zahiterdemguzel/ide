const { test } = require('node:test');
const assert = require('node:assert/strict');
const { folderLabel, jumpListCategories, dockMenuItems, newWindowTask, newInstanceCommand } = require('../src/main/native-recent-menu');

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

test('newWindowTask: relaunches the exe with only the extra args', () => {
  assert.deepEqual(newWindowTask('/opt/ide'), {
    type: 'task', program: '/opt/ide', args: '', title: 'New Window', description: 'New Window',
  });
  assert.equal(newWindowTask('/opt/electron', { extraArgs: ['"/src/app"'] }).args, '"/src/app"');
});

test('newInstanceCommand: packaged macOS asks LaunchServices for a new bundle instance', () => {
  assert.deepEqual(newInstanceCommand({
    platform: 'darwin', isPackaged: true,
    execPath: '/Applications/My IDE.app/Contents/MacOS/My IDE', appPath: '/ignored',
  }), { command: 'open', args: ['-n', '/Applications/My IDE.app'] });
});

test('newInstanceCommand: dev run spawns Electron with the app directory', () => {
  assert.deepEqual(newInstanceCommand({
    platform: 'darwin', isPackaged: false,
    execPath: '/x/Electron.app/Contents/MacOS/Electron', appPath: '/src/app',
  }), { command: '/x/Electron.app/Contents/MacOS/Electron', args: ['/src/app'] });
});

test('newInstanceCommand: packaged Windows/Linux spawns the exe itself', () => {
  assert.deepEqual(newInstanceCommand({
    platform: 'win32', isPackaged: true, execPath: 'C:\\ide\\ide.exe', appPath: 'C:\\ide\\resources\\app.asar',
  }), { command: 'C:\\ide\\ide.exe', args: [] });
});
