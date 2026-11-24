import { loadStepGeometry, editStepGeometry, stepPreview } from './step-kernel.mjs';

// Geometry and topology stay in this document's worker. Only display tessellations
// and the explicitly exported STEP cross back to the renderer.
const history = [];
let index = -1;
let version = 0;
self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'export') {
      const bytes = await history[index].shape.blobSTEP().arrayBuffer();
      self.postMessage({ bytes }, [bytes]);
      return;
    }
    let mesh;
    if (data.action === 'load' || data.action === 'apply') {
      const shape = data.action === 'load' ? await loadStepGeometry(data.bytes)
        : editStepGeometry(history[index].shape, data.operation, data.values);
      try { mesh = stepPreview(shape); }
      catch (err) { shape.delete(); throw err; }
      for (const item of history.splice(index + 1)) item.shape.delete();
      history.push({ shape, version: ++version });
      // Bound the native-memory cost of undo for large mechanical designs.
      if (history.length > 20) history.shift().shape.delete();
      index = history.length - 1;
    } else {
      const next = index + (data.action === 'undo' ? -1 : 1);
      mesh = stepPreview(history[next].shape);
      index = next;
    }
    self.postMessage({ mesh, version: history[index].version,
      canUndo: index > 0, canRedo: index < history.length - 1 },
    Object.values(mesh).map(array => array.buffer));
  } catch (err) {
    self.postMessage({ error: err?.message || 'The CAD kernel could not complete this operation.' });
  }
};
