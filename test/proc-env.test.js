const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanEnv } = require('../src/main/proc-env');

test('cleanEnv: drops the VS Code / Electron debugger variables', () => {
  const out = cleanEnv({
    PATH: '/usr/bin',
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_INSPECTOR_OPTIONS: ':::',
    VSCODE_PID: '123',
  });
  assert.equal(out.PATH, '/usr/bin');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in out));
  assert.ok(!('VSCODE_INSPECTOR_OPTIONS' in out));
  assert.ok(!('VSCODE_PID' in out));
});

test('cleanEnv: strips the js-debug require and every --inspect* variant from NODE_OPTIONS', () => {
  const out = cleanEnv({
    NODE_OPTIONS: '--require /x/js-debug/bootloader.js --inspect-publish-uid=http',
  });
  assert.ok(!('NODE_OPTIONS' in out), 'NODE_OPTIONS made empty -> removed entirely');
});

test('cleanEnv: keeps a benign NODE_OPTIONS value', () => {
  const out = cleanEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.equal(out.NODE_OPTIONS, '--max-old-space-size=4096');
});

test('cleanEnv: leaves a clean environment untouched and does not mutate the input', () => {
  const input = { PATH: '/bin', HOME: '/home/u' };
  const out = cleanEnv(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input, 'returns a copy, not the same object');
});
