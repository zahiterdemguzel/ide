const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveFreeCAD, openInFreeCAD } = require('../src/main/cad-freecad');

function installed(platform, env, files, list = () => []) {
  return resolveFreeCAD({ platform, env, home: '/home/test', executable: file => files.includes(file), list });
}

test('FreeCAD resolves platform installations and versioned Windows Program Files', () => {
  const mac = '/Applications/FreeCAD.app/Contents/MacOS/FreeCAD';
  assert.equal(installed('darwin', {}, [mac]), mac);
  const flatpak = '/home/test/.local/share/flatpak/exports/bin/org.freecad.FreeCAD';
  assert.equal(installed('linux', {}, [flatpak]), flatpak);

  const root = 'C:\\Program Files';
  const older = root + '\\FreeCAD 0.21\\bin\\FreeCAD.exe';
  const newest = root + '\\FreeCAD 1.10\\bin\\FreeCAD.exe';
  assert.equal(installed('win32', { ProgramFiles: root }, [older, newest],
    () => ['FreeCAD 1.2', 'FreeCAD 0.21', 'FreeCAD 1.10']), newest);
});

test('FreeCAD accepts an explicit absolute executable and reports configuration errors', () => {
  const custom = '/opt/custom/FreeCAD AppImage';
  assert.equal(installed('linux', { FREECAD_EXECUTABLE: custom }, [custom]), custom);
  assert.throws(() => installed('linux', { FREECAD_EXECUTABLE: 'relative' }, ['relative']), /absolute path/);
  assert.throws(() => installed('linux', {}, []), /Install FreeCAD/);
  assert.equal(installed('linux', { PATH: '.:/usr/local/bin' }, ['FreeCAD', '/usr/local/bin/freecad']), '/usr/local/bin/freecad');
});

test('FreeCAD launcher accepts only absolute CAD document paths', async () => {
  await assert.rejects(openInFreeCAD('/tmp/commands.FCMacro'), /Select a STEP/);
  await assert.rejects(openInFreeCAD('part.stp'), /Select a STEP/);
});
