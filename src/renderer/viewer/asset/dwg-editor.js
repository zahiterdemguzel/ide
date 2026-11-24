import { base64ToArrayBuffer, arrayBufferToBase64 } from '../../shared/base64.js';
import { assetBtn } from './ui.js';
import { currentLocale, setTranslatedText, t } from '../../../i18n/index.js';

const EDITOR_ORIGIN = 'cad-editor://drawing';
const basename = file => file.split(/[\\/]/).pop();

export function renderDwgEditor(file, body, tools, registerCleanup, design) {
  const frame = document.createElement('iframe');
  frame.className = 'dwg-editor';
  frame.dataset.i18nTitle = 'cad.drawingTools';
  frame.title = t(frame.dataset.i18nTitle);
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  const status = tools.status;
  function showStatus(key, value = '') {
    if (key) setTranslatedText(status, key, value ? { file: value } : undefined);
    else {
      delete status.dataset.i18n;
      status.textContent = value;
    }
  }
  const name = basename(file).replace(/\.dwg$/i, '.dxf');
  let dirty = false;
  let pending = 0;
  let failed = false;
  let closed = false;
  let ready = false;
  let requested = false;
  let commandPending = false;
  let currentFile = file;
  let revision = design.revision;
  let savedCopy = false;
  let forceSaveAs = false;
  let queue = Promise.resolve();
  const hasChanges = () => dirty || pending > 0 || failed || requested || commandPending;
  const shouldClose = () => !hasChanges() || (!pending && !requested && !commandPending && window.confirm(t('cad.discardDrawing')));
  const timer = setTimeout(() => { showStatus('cad.editorFailed'); }, 45000);

  function requestSave(asCopy) {
    requested = true;
    forceSaveAs = asCopy;
    updateButtons();
    frame.contentWindow.postMessage({ type: 'ide:save' }, EDITOR_ORIGIN);
  }
  function runCommand(command) {
    commandPending = true;
    updateButtons();
    frame.contentWindow.postMessage({ type: 'ide:command', command }, EDITOR_ORIGIN);
    frame.focus();
  }
  const commands = document.createElement('select');
  commands.className = 'asset-btn dwg-command-picker';
  commands.dataset.i18nAriaLabel = 'cad.drawingTools';
  commands.setAttribute('aria-label', t(commands.dataset.i18nAriaLabel));
  const choice = (key, command) => setTranslatedText(new Option('', command), key);
  commands.add(choice('cad.drawingTools', ''));
  for (const [title, entries] of [
    ['toolDraw', [['line', 'toolLine'], ['pline', 'toolPolyline'], ['circle', 'toolCircle'], ['rectang', 'toolRectangle']]],
    ['toolModify', [['move', 'toolMove'], ['copy', 'toolCopy'], ['rotate', 'toolRotate'], ['trim', 'toolTrim']]],
    ['toolAnnotate', [['mtext', 'toolText'], ['dimlinear', 'toolDimension']]],
  ]) {
    const group = document.createElement('optgroup');
    group.dataset.i18nLabel = 'cad.' + title;
    group.label = t(group.dataset.i18nLabel);
    for (const [command, label] of entries) group.append(choice('cad.' + label, command));
    commands.append(group);
  }
  commands.onchange = () => {
    const command = commands.value;
    commands.selectedIndex = 0;
    if (command) runCommand(command);
  };
  const action = (key, handler) => setTranslatedText(assetBtn('', handler), key);
  const undo = action('cad.undo', () => runCommand('undo'));
  const redo = action('cad.redo', () => runCommand('redo'));
  const fit = action('cad.fit', () => runCommand('fit'));
  const save = action('cad.saveDwgAs', () => requestSave(!savedCopy));
  const saveAs = action('cad.saveCopy', () => requestSave(true));
  save.dataset.i18nTitle = 'cad.saveDwgHint';
  save.title = t(save.dataset.i18nTitle);
  function updateButtons() {
    setTranslatedText(save, savedCopy ? 'cad.saveDwg' : 'cad.saveDwgAs');
    save.disabled = !ready || requested || pending > 0 || commandPending;
    for (const control of [undo, redo, fit, commands]) control.disabled = save.disabled;
    saveAs.hidden = !savedCopy;
    saveAs.disabled = save.disabled;
  }

  function syncAppearance() {
    const id = document.documentElement.dataset.theme;
    const theme = id === 'light' || id === 'solarized-light' ? 'light' : 'dark';
    frame.contentWindow.postMessage({ type: 'ide:appearance', theme, language: currentLocale() }, EDITOR_ORIGIN);
  }
  const appearanceChanges = new MutationObserver(syncAppearance);

  async function saveDrawing({ bytes, name: drawingName }, asCopy) {
    try {
      if (!/\.dxf$/i.test(drawingName)) {
        const url = URL.createObjectURL(new Blob([bytes]));
        const link = document.createElement('a');
        link.href = url;
        link.download = basename(drawingName);
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        showStatus('cad.exported', link.download);
        return;
      }
      showStatus('cad.working');
      const payload = { file: currentFile, revision, base64: arrayBufferToBase64(bytes) };
      // A first save asks for a new destination because DWG/DXF round trips
      // can lose custom objects. Further saves target the user's chosen file.
      const originalDrawing = drawingName === name;
      const copy = asCopy || !savedCopy || !originalDrawing;
      const result = await (copy ? window.api.saveCadDesignAs(payload) : window.api.saveCadDesign(payload));
      if (result.canceled) { failed = true; showStatus('cad.exportCanceled'); return; }
      if (!result.ok) throw new Error(result.error || t('cad.saveFailed'));
      if (originalDrawing) {
        currentFile = result.file || currentFile;
        revision = result.revision;
        savedCopy = true;
        tools.setFile(currentFile);
      }
      failed = false;
      showStatus('cad.saved', basename(result.file || currentFile));
    } catch (e) {
      failed = true;
      showStatus(null, e.message || String(e));
    } finally {
      pending--;
      updateButtons();
    }
  }

  const handle = (event) => {
    if (closed || event.source !== frame.contentWindow || event.origin !== EDITOR_ORIGIN) return;
    const data = event.data;
    if (data?.type === 'cadcraft:ready') {
      syncAppearance();
      appearanceChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
      const bytes = base64ToArrayBuffer(design.base64);
      frame.contentWindow.postMessage({ type: 'cadcraft:open', name, bytes }, EDITOR_ORIGIN, [bytes]);
      showStatus('cad.loading');
    } else if (data?.type === 'ide:opened') {
      clearTimeout(timer);
      showStatus('cad.ready');
      ready = true;
      updateButtons();
    } else if (data?.type === 'ide:command-finished') {
      commandPending = false;
      showStatus(data.error ? null : dirty ? 'cad.unsaved' : 'cad.ready', data.error);
      updateButtons();
    } else if (data?.type === 'cadcraft:failed' || data?.type === 'ide:save-failed') {
      clearTimeout(timer);
      requested = false;
      showStatus(data.error ? null : 'cad.editorFailed', data.error);
      updateButtons();
    } else if (data?.type === 'cadcraft:dirty') {
      dirty = Boolean(data.dirty);
      if (dirty && !pending) showStatus('cad.unsaved');
      else if (!dirty && !failed && status.dataset.i18n === 'cad.unsaved') showStatus('cad.ready');
    } else if (data?.type === 'cadcraft:save' && typeof data.name === 'string' && data.bytes instanceof ArrayBuffer) {
      const asCopy = requested && forceSaveAs;
      requested = false;
      pending++;
      updateButtons();
      queue = queue.then(() => saveDrawing(data, asCopy));
    }
  };
  registerCleanup(() => {
    closed = true;
    clearTimeout(timer);
    window.removeEventListener('message', handle);
    appearanceChanges.disconnect();
    frame.remove();
  }, shouldClose, hasChanges);
  window.addEventListener('message', handle);
  showStatus('cad.loading');
  updateButtons();
  tools.file.append(save, saveAs);
  tools.edit.append(undo, redo, commands);
  tools.view.append(fit);
  frame.src = EDITOR_ORIGIN + '/?webgl';
  body.replaceChildren(frame);
}
