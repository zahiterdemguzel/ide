const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFolderArg } = require('../src/main/cli-args');

test('parseFolderArg: --folder <path> (space form)', () => {
  assert.equal(parseFolderArg(['electron', '.', '--folder', '/tmp/ws']), '/tmp/ws');
});

test('parseFolderArg: --folder=<path> (equals form)', () => {
  assert.equal(parseFolderArg(['--folder=/tmp/ws']), '/tmp/ws');
});

test('parseFolderArg: --dir alias works both forms', () => {
  assert.equal(parseFolderArg(['--dir', '/a']), '/a');
  assert.equal(parseFolderArg(['--dir=/b']), '/b');
});

test('parseFolderArg: returns null when the flag is absent', () => {
  assert.equal(parseFolderArg(['electron', '.', '--inspect']), null);
});

test('parseFolderArg: returns null when --folder has no value', () => {
  assert.equal(parseFolderArg(['--folder']), null);
  assert.equal(parseFolderArg(['--folder=']), null);
});

test('parseFolderArg: first occurrence wins', () => {
  assert.equal(parseFolderArg(['--folder', '/first', '--folder', '/second']), '/first');
});

test('parseFolderArg: keeps a path with spaces intact', () => {
  assert.equal(parseFolderArg(['--folder', '/path/with spaces']), '/path/with spaces');
});

test('parseFolderArg: tolerates a non-array argv', () => {
  assert.equal(parseFolderArg(undefined), null);
});
