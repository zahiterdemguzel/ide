const { test } = require('node:test');
const assert = require('node:assert/strict');
const { binRelPath, pickPort } = require('../src/main/ollama-bin-lib');

test('binRelPath: per-platform subdir and exe name', () => {
  assert.deepEqual(binRelPath('win32', 'x64'), { subdir: 'win32-x64', exe: 'ollama.exe' });
  assert.deepEqual(binRelPath('darwin', 'arm64'), { subdir: 'darwin-arm64', exe: 'ollama' });
  assert.deepEqual(binRelPath('linux', 'x64'), { subdir: 'linux-x64', exe: 'ollama' });
});

test('binRelPath: unknown arch falls back to x64', () => {
  assert.equal(binRelPath('win32', 'ia32').subdir, 'win32-x64');
});

test('pickPort: steps past known-taken ports', () => {
  assert.equal(pickPort(11434, []), 11434);
  assert.equal(pickPort(11434, [11434, 11435]), 11436);
});

test('pickPort: 0/invalid means ephemeral', () => {
  assert.equal(pickPort(0, []), 0);
  assert.equal(pickPort('nope', []), 0);
});
