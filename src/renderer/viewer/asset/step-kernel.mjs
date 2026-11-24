import initOpenCascade from '../../../../node_modules/replicad-opencascadejs/dist/replicad_single.js';
import { setOC, importSTEP, makeBox, makeCylinder } from '../../../../node_modules/replicad/dist/replicad.js';

let kernel;
export function initStepKernel() {
  kernel ??= initOpenCascade().then(setOC);
  return kernel;
}

export async function loadStepGeometry(bytes) {
  await initStepKernel();
  return importSTEP(new globalThis.Blob([bytes]));
}

export function editStepGeometry(shape, operation, values) {
  if (!values.every(Number.isFinite)) throw new Error('Enter finite dimensions.');
  switch (operation) {
    case 'translate':
      if (values.length === 3) return shape.clone().translate(values);
      break;
    case 'rotate':
      if (values.length === 2 && [0, 1, 2].includes(values[0])) {
        const axis = [0, 0, 0];
        axis[values[0]] = 1;
        return shape.clone().rotate(values[1], [0, 0, 0], axis);
      }
      break;
    case 'scale':
      if (values.length === 1 && values[0] > 0) return shape.clone().scale(values[0]);
      break;
    case 'bore': {
      const [x, y, z, diameter, length] = values;
      if (values.length !== 5 || diameter <= 0 || length <= 0) break;
      if (typeof shape.cut !== 'function') throw new Error('Boring requires a solid or compound.');
      const cylinder = makeCylinder(diameter / 2, length, [x, y, z]);
      try { return shape.cut(cylinder); }
      finally { cylinder.delete(); }
    }
    case 'fuse':
    case 'cut': {
      if (values.length !== 6 || values.slice(3).some(size => size <= 0)) break;
      if (typeof shape[operation] !== 'function') throw new Error('Box operations require a solid or compound.');
      const start = values.slice(0, 3);
      const end = start.map((coordinate, axis) => coordinate + values[axis + 3]);
      const box = makeBox(start, end);
      try { return shape[operation](box); }
      finally { box.delete(); }
    }
  }
  throw new Error('Enter valid dimensions for this operation.');
}

export function stepPreview(shape) {
  const options = { tolerance: 0.1, angularTolerance: 0.25 };
  const { vertices, triangles, normals } = shape.mesh(options);
  const { lines } = shape.meshEdges(options);
  if (!triangles.length && !lines.length) throw new Error('The result contains no displayable edges or faces.');
  return {
    vertices: new Float32Array(vertices), normals: new Float32Array(normals),
    triangles: new Uint32Array(triangles), lines: new Float32Array(lines),
  };
}
