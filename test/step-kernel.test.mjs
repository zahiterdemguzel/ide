import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBox, measureVolume } from 'replicad';
import { initStepKernel, loadStepGeometry, editStepGeometry, stepPreview } from '../src/renderer/viewer/asset/step-kernel.mjs';

test('STEP import → cut → move → scale → export preserves exact solids on re-open', async () => {
  await initStepKernel();
  const cube = makeBox([0, 0, 0], [20, 20, 20]);
  const loaded = await loadStepGeometry(await cube.blobSTEP().arrayBuffer());
  assert.ok(stepPreview(loaded).triangles.length > 0);
  const cut = editStepGeometry(loaded, 'cut', [0, 0, 0, 10, 10, 10]);
  const moved = editStepGeometry(cut, 'translate', [30, 0, 0]);
  const twice = editStepGeometry(moved, 'scale', [2]);
  const reopened = await loadStepGeometry(await twice.blobSTEP().arrayBuffer());
  assert.ok(Math.abs(measureVolume(reopened) - 56000) < 0.0001);
  const box = reopened.boundingBox;
  assert.ok(Math.abs(box.bounds[0][0] - 60) < 0.0001);
  assert.ok(Math.abs(measureVolume(loaded) - 8000) < 0.0001, 'undo must retain the imported shape');
  const bored = editStepGeometry(loaded, 'bore', [10, 10, 0, 4, 20]);
  const rotated = editStepGeometry(bored, 'rotate', [0, 90]);
  assert.ok(Math.abs(measureVolume(rotated) - (8000 - Math.PI * 4 * 20)) < 0.0001);
  assert.throws(() => editStepGeometry(loaded, 'cut', [0, 0, 0, -5, 0, 0]), /valid dimensions/);
  assert.throws(() => editStepGeometry(loaded, 'rotate', [Infinity]), /finite dimensions/);
  for (const item of [cube, loaded, cut, moved, twice, reopened, box, bored, rotated]) item.delete();
});
