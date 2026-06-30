import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateTextures } from '../src/renderer/shared/model-textures.js';

// Minimal duck-typed scene-graph builders — enumerateTextures only reads
// `.children`, `.isMesh`, and the material map slots, so plain objects suffice.
const tex = (name, colorSpace = 'srgb') => ({ isTexture: true, name, colorSpace });
const mesh = (material, children = []) => ({ isMesh: true, material, children });
const group = (children) => ({ children });

test('collects the base-color map of a single mesh', () => {
  const t = tex('albedo');
  const entries = enumerateTextures(mesh({ map: t }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].texture, t);
  assert.equal(entries[0].label, 'albedo');
  assert.deepEqual(entries[0].slots, [{ material: entries[0].slots[0].material, key: 'map' }]);
});

test('dedupes a texture shared by two materials into one entry with two slots', () => {
  const shared = tex('shared');
  const a = { map: shared };
  const b = { map: shared };
  const entries = enumerateTextures(group([mesh(a), mesh(b)]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].slots.length, 2);
  assert.equal(entries[0].label, 'shared ×2'); // slot count surfaced in the label
  assert.deepEqual(entries[0].slots.map((s) => s.material), [a, b]);
});

test('handles an array material (multi-material mesh)', () => {
  const t1 = tex('one');
  const t2 = tex('two');
  const entries = enumerateTextures(mesh([{ map: t1 }, { map: t2 }]));
  assert.deepEqual(entries.map((e) => e.texture), [t1, t2]);
});

test('ignores non-color slots by default (normal/roughness maps excluded)', () => {
  const m = mesh({ normalMap: tex('n'), roughnessMap: tex('r') });
  assert.deepEqual(enumerateTextures(m), []);
});

test('a mapless mesh yields no entries', () => {
  assert.deepEqual(enumerateTextures(mesh({ color: 0xffffff })), []);
});

test('skips null material slots and recurses through groups', () => {
  const t = tex('deep');
  const tree = group([group([mesh(null), mesh({ map: t })])]);
  const entries = enumerateTextures(tree);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].texture, t);
});

test('falls back to the material name then an index for unnamed textures', () => {
  const t = tex(''); // unnamed texture
  const entries = enumerateTextures(mesh({ map: t, name: undefined }, []));
  // material has no name either → "Texture 1"
  assert.equal(entries[0].label, 'Texture 1');
});
