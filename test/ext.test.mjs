import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extOf, fileColor, IMG_EXT, AUDIO_EXT, MODEL_EXT, EDITABLE_MODEL_EXT } from '../src/renderer/shared/ext.js';

test('extOf: returns the lowercased extension after the last dot', () => {
  assert.equal(extOf('index.js'), 'js');
  assert.equal(extOf('archive.tar.gz'), 'gz');
  assert.equal(extOf('Photo.PNG'), 'png');
});

test('extOf: no extension -> empty string', () => {
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('README'), '');
});

test('extOf: a leading dot is not treated as an extension', () => {
  assert.equal(extOf('.gitignore'), 'gitignore'); // single segment after the dot
  assert.equal(extOf('.env'), 'env');
});

test('IMG_EXT / AUDIO_EXT / MODEL_EXT cover the asset-viewer types', () => {
  for (const e of ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']) assert.ok(IMG_EXT.has(e));
  for (const e of ['wav', 'ogg', 'mp3']) assert.ok(AUDIO_EXT.has(e));
  for (const e of ['glb', 'gltf', 'fbx', 'obj', 'usdz', 'stl', 'ply']) assert.ok(MODEL_EXT.has(e));
});

test('EDITABLE_MODEL_EXT is the glTF subset of MODEL_EXT', () => {
  for (const e of EDITABLE_MODEL_EXT) assert.ok(MODEL_EXT.has(e), `${e} must be a model ext`);
  assert.deepEqual([...EDITABLE_MODEL_EXT].sort(), ['glb', 'gltf']);
  for (const e of ['fbx', 'obj', 'usdz', 'stl', 'ply']) assert.ok(!EDITABLE_MODEL_EXT.has(e));
});

test('the asset-viewer extension sets are disjoint (one routing per type)', () => {
  const sets = [IMG_EXT, AUDIO_EXT, MODEL_EXT];
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++)
      for (const e of sets[i]) assert.ok(!sets[j].has(e), `${e} is in two asset sets`);
});

test('fileColor: known extensions get their mapped colour', () => {
  assert.equal(fileColor('app.js'), '#f1e05a');
  assert.equal(fileColor('main.ts'), '#4a9eff');
  assert.equal(fileColor('logo.png'), '#26a69a');
  assert.equal(fileColor('robot.glb'), '#ff7043');
});

test('fileColor: case-insensitive on the extension', () => {
  assert.equal(fileColor('APP.JS'), '#f1e05a');
});

test('fileColor: unknown / extensionless names fall back to --fg', () => {
  assert.equal(fileColor('mystery.zzz'), 'var(--fg)');
  assert.equal(fileColor('Makefile'), 'var(--fg)');
});
