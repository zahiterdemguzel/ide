import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDoc, ensureModelForUri } from '../src/renderer/editor/documents.js';

test('CAD designs never enter the text editor, including language server navigation', async () => {
  for (const file of ['part.STEP', '/tmp/cad/assembly.stp', 'plan.DWG', 'project.FCStd']) {
    assert.deepEqual(await ensureDoc(file), { binary: true });
    assert.equal(await ensureModelForUri({ fsPath: file }), null);
  }
});
