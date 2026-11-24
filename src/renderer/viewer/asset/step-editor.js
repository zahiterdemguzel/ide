import * as THREE from 'three';
import { createViewer, disposeScene, frameObject } from './model-scene.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../../shared/base64.js';
import { assetBtn } from './ui.js';
import { t, setTranslatedText } from '../../../i18n/index.js';

const position = ['X', 'Y', 'Z'].map(name => ({ name, value: 0, unit: 'mm' }));
const dimension = (name, value) => ({ name, value, unit: 'mm', positive: true });
const boxSize = ['width', 'depth', 'height'].map(name => dimension(name, 10));
const operations = {
  translate: [['offset', position]],
  rotate: [['rotation', [{ name: 'axis', options: ['X', 'Y', 'Z'], value: 2 }, { name: 'angle', value: 90, unit: '°' }]]],
  scale: [['scaling', [{ name: 'factor', value: 1, unit: '×', positive: true }]]],
  fuse: [['origin', position], ['size', boxSize]],
  cut: [['origin', position], ['size', boxSize]],
  bore: [['origin', position], ['boreSize', [dimension('diameter', 5), dimension('length', 10)]]],
};

const stepLabel = name => t('cad.step.' + name);

function cadButton(key, onClick) {
  return setTranslatedText(assetBtn('', onClick), key);
}

function fieldset(className, section) {
  const group = document.createElement('fieldset');
  group.className = className;
  const legend = document.createElement('legend');
  setTranslatedText(legend, 'cad.step.' + section);
  group.append(legend);
  return group;
}

function operationField({ name, value, unit, options, positive }) {
  const label = document.createElement('label');
  label.className = 'step-field';
  const caption = document.createElement('span');
  if (['X', 'Y', 'Z'].includes(name)) caption.textContent = name;
  else setTranslatedText(caption, 'cad.step.' + name);
  const entry = document.createElement('span');
  entry.className = 'step-entry';
  let control;
  if (options) {
    control = document.createElement('select');
    options.forEach((option, i) => control.add(new Option(option, String(i))));
  } else {
    control = document.createElement('input');
    control.type = 'number';
    control.step = 'any';
    control.required = true;
    if (positive) control.oninput = () => {
      control.setCustomValidity(control.valueAsNumber <= 0 ? stepLabel('positive') : '');
    };
  }
  control.value = String(value);
  entry.append(control);
  if (unit) {
    const suffix = document.createElement('span');
    suffix.className = 'step-unit';
    suffix.textContent = unit;
    entry.append(suffix);
  }
  label.append(caption, entry);
  return label;
}

function modelObject(mesh) {
  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
  group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0x8bb5ca, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  })));
  const edges = new THREE.BufferGeometry();
  edges.setAttribute('position', new THREE.BufferAttribute(mesh.lines, 3));
  group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x2b424d })));
  // The orbit viewer's grid lies in XZ. Show CAD Z as its vertical axis.
  group.rotation.x = -Math.PI / 2;
  return group;
}

export function renderStepEditor(file, body, tools, registerCleanup, design) {
  const editor = document.createElement('div');
  editor.className = 'step-editor';
  const viewport = document.createElement('div');
  viewport.className = 'step-viewport';
  const form = document.createElement('form');
  form.className = 'step-operations';
  const palette = document.createElement('div');
  palette.className = 'step-tool-palette';
  const settings = document.createElement('div');
  settings.className = 'step-tool-settings';
  const fields = document.createElement('div');
  fields.className = 'step-fields';
  const status = tools.status;
  const apply = cadButton('cad.step.apply', null);
  apply.classList.add('step-apply');
  apply.type = 'submit';
  let operation = 'translate';
  const buttons = new Map();
  const drafts = new Map();

  function chooseTool(next) {
    if (fields.childElementCount) {
      drafts.set(operation, Array.from(fields.querySelectorAll('input, select'), control => control.value));
    }
    operation = next;
    for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(key === next));
    fields.replaceChildren(...operations[next].map(([section, params]) => {
      const group = fieldset('step-param-group', section);
      const row = document.createElement('div');
      row.className = 'step-param-row';
      row.append(...params.map(operationField));
      group.append(row);
      return group;
    }));
    if (drafts.has(next)) {
      fields.querySelectorAll('input, select').forEach((control, i) => {
        control.value = drafts.get(next)[i];
        control.oninput?.();
      });
    }
  }
  for (const [section, keys] of [['transform', ['translate', 'rotate', 'scale']], ['solid', ['fuse', 'cut', 'bore']]]) {
    const group = fieldset('step-tool-group', section);
    const row = document.createElement('div');
    row.className = 'step-tool-row';
    for (const key of keys) {
      const button = cadButton('cad.step.' + key, () => { if (key !== operation) chooseTool(key); });
      button.type = 'button';
      button.dataset.operation = key;
      buttons.set(key, button);
      row.append(button);
    }
    group.append(row);
    palette.append(group);
  }
  settings.append(fields, apply);
  form.append(palette, settings);
  editor.append(viewport, form);
  body.append(editor);
  chooseTool(operation);

  const viewer = createViewer(viewport);
  const worker = new Worker(new URL('./step-worker.js', import.meta.url), { type: 'module' });
  let object, frame, busy = false, disposed = false, exporting = false;
  let state = { version: 0, canUndo: false, canRedo: false };
  let savedVersion = 0;
  let sourceRevision = design.revision;
  let displayOrigin;
  const dirty = () => state.version !== savedVersion;
  const undo = cadButton('cad.undo', () => request({ action: 'undo' }));
  const redo = cadButton('cad.redo', () => request({ action: 'redo' }));
  const fit = cadButton('cad.fit', () => frame?.());
  const save = cadButton('cad.step.export', () => {
    exporting = true;
    request({ action: 'export' });
  });
  save.dataset.i18nTitle = 'cad.step.exportHint';
  save.title = t(save.dataset.i18nTitle);
  tools.edit.append(undo, redo);
  tools.view.append(fit);
  tools.file.append(save);

  function updateControls() {
    apply.disabled = !state.version || busy;
    undo.disabled = !state.canUndo || busy;
    redo.disabled = !state.canRedo || busy;
    save.disabled = !state.version || busy;
    fit.disabled = !state.version || busy;
  }
  function request(message, transfer = []) {
    if (busy || disposed) return;
    busy = true;
    setTranslatedText(status, message.action === 'load' ? 'cad.loading' : 'cad.working');
    updateControls();
    worker.postMessage(message, transfer);
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (!apply.disabled) request({ action: 'apply', operation,
      values: Array.from(fields.querySelectorAll('input, select'), control => Number(control.value)) });
  };

  function draw(mesh) {
    if (object) {
      viewer.scene.remove(object);
      disposeScene(object);
    }
    object = modelObject(mesh);
    viewer.scene.add(object);
    if (!displayOrigin) {
      frame = frameObject(object, viewer.camera, viewer.controls, viewer.grid);
      displayOrigin = object.position.clone();
      viewer.resize();
      viewer.start();
    } else {
      object.position.copy(displayOrigin);
    }
    frame = () => {
      object.position.set(0, 0, 0);
      frameObject(object, viewer.camera, viewer.controls, viewer.grid);
      displayOrigin.copy(object.position);
    };
  }

  worker.onmessage = async ({ data }) => {
    if (disposed) return;
    try {
      if (data.error) throw new Error(data.error);
      if (data.bytes) {
        const result = await window.api.saveCadDesignAs({ file, revision: sourceRevision,
          base64: arrayBufferToBase64(data.bytes) });
        if (disposed) return;
        if (result.canceled) setTranslatedText(status, 'cad.exportCanceled');
        else {
          if (!result.ok) throw new Error(result.error || stepLabel('exportFailed'));
          savedVersion = state.version;
          if (file === result.file) sourceRevision = result.revision;
          setTranslatedText(status, 'cad.exported', { file: result.file });
        }
      } else {
        draw(data.mesh);
        if (!state.version) savedVersion = data.version;
        state = { version: data.version, canUndo: data.canUndo, canRedo: data.canRedo };
        setTranslatedText(status, dirty() ? 'cad.unsaved' : 'cad.ready');
      }
    } catch (error) {
      delete status.dataset.i18n;
      status.textContent = error.message;
    } finally {
      busy = false;
      exporting = false;
      if (!disposed) updateControls();
    }
  };
  worker.onerror = event => {
    delete status.dataset.i18n;
    status.textContent = event.message || stepLabel('engineFailed');
    busy = true;
    exporting = false;
    updateControls();
  };

  const shouldClose = () => !exporting && (!dirty() || window.confirm(stepLabel('discard')));
  registerCleanup(() => {
    disposed = true;
    worker.terminate();
    viewer.dispose();
  }, shouldClose, () => exporting || dirty());
  const bytes = base64ToArrayBuffer(design.base64);
  request({ action: 'load', bytes }, [bytes]);
}
