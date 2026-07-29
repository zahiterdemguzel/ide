import { assetBtn } from './ui.js';
import { refreshGit } from '../../git-pane.js';
import { showFile } from '../file.js';
import { hideAsset } from './index.js';
import { t } from '../../../i18n/index.js';
import {
  parseTscn, serializeTscn, nodeSections, nodePathOf, findNode, attrStr, getProp, setProp,
  addNode, removeNodeTree, reparentNode, renameNode, duplicateNode, moveSibling,
  addExtResource, addSubResource, uniqueChildName, quote,
} from '../../shared/tscn.js';
import { anchorsOf, offsetsForRect, writeRect } from '../../shared/tscn-layout.js';
import { isContainerType } from '../../shared/control-layout.js';
import { godotRootOf, textureEntries, nodeNameFor } from '../../shared/scene-assets.js';
import { parseProjectGodot, viewportSize, DEFAULT_VIEWPORT } from '../../shared/godot-project.js';
import { createUiCanvas } from './ui-canvas.js';
import { createOutliner, startRenameFor } from './ui-outliner.js';
import { createInspector } from './ui-inspector.js';

// The Godot UI (Control) scene editor. The parsed document is the source of
// truth and the canvas is a pure function of it, so an undo is just "restore
// the document text and repaint" — no scene-graph mirroring like the 3D editor
// needs. Every mutation funnels through `edit()`, which snapshots before/after
// and coalesces same-key edits (a number drag, a burst of typing) into one
// undo entry.

// Node types the Add menu offers, grouped the way Godot's create dialog is.
const ADDABLE = [
  ['Base', ['Control', 'Panel', 'PanelContainer', 'ColorRect', 'NinePatchRect', 'TextureRect']],
  ['Text', ['Label', 'RichTextLabel']],
  ['Input', ['Button', 'TextureButton', 'CheckBox', 'CheckButton', 'OptionButton', 'LineEdit', 'TextEdit']],
  ['Range', ['ProgressBar', 'HSlider', 'VSlider']],
  ['Containers', ['VBoxContainer', 'HBoxContainer', 'GridContainer', 'MarginContainer', 'CenterContainer',
    'ScrollContainer', 'HSplitContainer', 'VSplitContainer', 'TabContainer', 'AspectRatioContainer']],
  ['Other', ['HSeparator', 'VSeparator', 'CanvasLayer', 'Node2D', 'Sprite2D']],
];

// Sensible starting rects so a new node is visible and grabbable.
const DEFAULT_SIZE = {
  Button: [100, 31], CheckBox: [100, 24], CheckButton: [110, 24], OptionButton: [120, 31],
  LineEdit: [160, 31], TextEdit: [200, 100], Label: [100, 26], RichTextLabel: [200, 100],
  ProgressBar: [160, 24], HSlider: [160, 16], VSlider: [16, 160],
  HSeparator: [160, 4], VSeparator: [4, 160],
};

const TEXTURE_MIME = 'application/x-godot-texture';

export function renderUiSceneEditor(file, text, body, tools, registerCleanup, onSwitchTo3d) {
  let doc = parseTscn(text);
  if (!nodeSections(doc).length) {
    body.textContent = 'Not a Godot scene: no [node] sections found.';
    registerCleanup(() => {});
    return;
  }

  let selection = [];
  let view = { ...DEFAULT_VIEWPORT };
  let disposed = false;

  // --- header ---
  const status = document.createElement('span');
  status.className = 'asset-pct';
  let saving = false, dirty = false;
  const setStatus = (s) => { status.textContent = s; };
  const refreshSave = () => { saveBtn.disabled = !dirty || saving; };
  const markDirty = () => { dirty = true; setStatus(''); refreshSave(); };

  const seg = document.createElement('div');
  seg.className = 'asset-seg previewing';
  seg.setAttribute('role', 'switch');
  seg.setAttribute('aria-checked', 'true');
  seg.tabIndex = 0;
  seg.title = t('editor.codeTitle');
  const segCode = document.createElement('button');
  segCode.type = 'button';
  segCode.className = 'seg-opt';
  segCode.textContent = t('editor.code');
  const segPreview = document.createElement('button');
  segPreview.type = 'button';
  segPreview.className = 'seg-opt active';
  segPreview.textContent = t('editor.preview');
  const segThumb = document.createElement('span');
  segThumb.className = 'seg-thumb';
  segThumb.setAttribute('aria-hidden', 'true');
  seg.append(segCode, segPreview, segThumb);
  const toCode = () => { hideAsset(); showFile(file); };
  seg.onclick = (e) => { const opt = e.target.closest('.seg-opt'); if (!opt || opt === segCode) toCode(); };
  seg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toCode(); }
  });

  const saveBtn = assetBtn('Save', () => save());
  saveBtn.classList.add('adjust-apply');
  saveBtn.title = 'Save changes back to the file (Ctrl+S)';

  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'asset-pct uis-zoom';
  const fitBtn = assetBtn('Fit', () => canvas.zoomToFit());
  fitBtn.title = 'Fit the design viewport (Ctrl+0)';
  const gridBtn = assetBtn('Grid', () => {
    const g = canvas.getGrid();
    canvas.setGrid({ snap: !g.snap });
    gridBtn.classList.toggle('on', !g.snap);
  });
  gridBtn.title = 'Snap moves and resizes to the grid';
  const dupBtn = assetBtn('Duplicate', () => duplicateSelected());
  dupBtn.title = 'Duplicate the selected node (Ctrl+D)';
  const delBtn = assetBtn('Delete', () => deleteSelected());
  delBtn.title = 'Delete the selected node and its children (Del)';

  const tools3d = onSwitchTo3d ? assetBtn('3D view', () => onSwitchTo3d()) : null;
  if (tools3d) tools3d.title = 'Open this scene in the 3D scene editor instead';

  tools.append(seg, fitBtn, gridBtn, dupBtn, delBtn, ...(tools3d ? [tools3d] : []), saveBtn, zoomLabel, status);

  // --- undo / redo ---
  // Commands hold the whole document text before and after, so undo never has
  // to reverse an operation — it re-parses the earlier text.
  const undoStack = [], redoStack = [];
  let gesture = null;
  const snapshot = () => ({ text: serializeTscn(doc), selection: [...selection] });

  const beginGesture = (label) => { if (!gesture) gesture = { label, ...snapshot() }; };
  const commitGesture = (label) => {
    if (!gesture) return;
    const before = gesture;
    gesture = null;
    push(before, label, null);
    refreshAll(); // the drag only repainted the canvas; catch the panels up
  };
  const push = (before, label, mergeKey) => {
    const after = serializeTscn(doc);
    if (after === before.text) return;
    const top = undoStack[undoStack.length - 1];
    if (mergeKey && top && top.mergeKey === mergeKey && Date.now() - top.at < 700) {
      top.after = after;
      top.at = Date.now();
    } else {
      undoStack.push({ before: before.text, after, selection: before.selection, mergeKey, at: Date.now() });
    }
    redoStack.length = 0;
    markDirty();
  };

  // The single mutation entry point used by the inspector, outliner and canvas.
  const edit = (label, fn) => {
    const before = gesture ? null : snapshot();
    fn(doc);
    if (before) push(before, label, label);
    refreshAll();
  };

  const restore = (text, sel) => {
    doc = parseTscn(text);
    selection = sel.filter((p) => findNode(doc, p));
    refreshAll();
    markDirty();
  };
  const undo = () => {
    const c = undoStack.pop();
    if (!c) return;
    redoStack.push({ ...c, selection: [...selection] });
    restore(c.before, c.selection);
  };
  const redo = () => {
    const c = redoStack.pop();
    if (!c) return;
    undoStack.push({ ...c, at: 0 });
    restore(c.after, c.selection);
  };

  // --- textures ---
  // res:// paths resolve against the nearest project.godot; images decode once
  // and are cached, and a load that lands triggers a repaint (a texture changes
  // both the picture and any content-driven minimum size).
  let resRoot = null;
  const textureCache = new Map();
  const filesPromise = window.api.listFiles();
  const projectReady = filesPromise.then(async (r) => {
    if (!r || !r.ok) return;
    resRoot = godotRootOf(file, r.files) ?? '';
    const cfg = resRoot === null ? null : (resRoot ? resRoot + '/project.godot' : 'project.godot');
    if (!cfg || !r.files.includes(cfg)) return;
    const p = await window.api.readText(cfg);
    if (p && p.ok && !disposed) view = viewportSize(parseProjectGodot(p.text));
  });

  const repoPathOf = (res) => (resRoot === null ? null : (resRoot ? resRoot + '/' : '') + res.slice('res://'.length));
  const textureFor = (res) => {
    if (textureCache.has(res)) return textureCache.get(res);
    textureCache.set(res, null); // placeholder: one load attempt per path
    projectReady.then(() => {
      const repo = repoPathOf(res);
      if (!repo) return null;
      return window.api.readAsset(repo).then((r) => {
        if (!r || !r.ok || disposed) return;
        const img = new Image();
        img.onload = () => { if (!disposed) { textureCache.set(res, img); canvas.refresh(); } };
        img.src = `data:${r.mime};base64,${r.base64}`;
      });
    }).catch(() => {});
    return null;
  };

  // --- selection ---
  const setSelection = (paths) => {
    selection = [...new Set(paths)].filter((p) => findNode(doc, p));
    delBtn.disabled = !selection.length || selection.includes('.');
    dupBtn.disabled = !selection.length || selection.includes('.');
    outliner.syncSelection();
    inspector.rebuild();
    canvas.draw();
  };

  const refreshAll = () => {
    canvas.refresh();
    outliner.rebuild();
    outliner.syncSelection();
    inspector.rebuild();
    delBtn.disabled = !selection.length || selection.includes('.');
    dupBtn.disabled = !selection.length || selection.includes('.');
  };

  // --- canvas ---
  const canvas = createUiCanvas(body, {
    getDoc: () => doc,
    getViewportSize: () => view,
    textureFor,
    getSelection: () => selection,
    setSelection,
    beginGesture,
    commitGesture,
    // A drag writes offsets directly; anchors are left alone so the control
    // keeps whatever anchoring the author chose.
    applyRect: (path, rect) => {
      const node = findNode(doc, path);
      if (!node) return;
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
      const parent = canvas.getLayout().get(parentPath);
      const origin = path === '.' ? { x: 0, y: 0 } : (parent ? parent.rect : { x: 0, y: 0 });
      const size = path === '.' ? { w: view.width, h: view.height } : (parent ? { w: parent.rect.w, h: parent.rect.h } : view);
      const local = { x: rect.x - origin.x, y: rect.y - origin.y, w: rect.w, h: rect.h };
      writeRect(doc, path, { anchors: anchorsOf(node), offsets: offsetsForRect(local, anchorsOf(node), size) });
    },
    onZoom: (z) => { zoomLabel.textContent = Math.round(z * 100) + '%'; },
  });

  // --- panels ---
  const outliner = createOutliner(canvas.wrap, {
    getDoc: () => doc,
    getLayout: () => canvas.getLayout(),
    getSelection: () => selection,
    setSelection,
    onToggleVisible: (path) => edit(`visible:${path}`, (d) => {
      const n = findNode(d, path);
      if (getProp(n, 'visible') === 'false') n.props.splice(n.props.findIndex((p) => p.key === 'visible'), 1);
      else setProp(n, 'visible', 'false');
    }),
    onRename: (path, name) => {
      let moved = path;
      edit(`rename:${path}`, (d) => { moved = renameNode(d, path, name).path; });
      setSelection([moved]);
    },
    onReparent: (child, newParent) => {
      let moved = child;
      edit(`reparent:${child}`, (d) => { moved = reparentNode(d, child, newParent).path; });
      setSelection([moved]);
    },
  });

  const inspector = createInspector(canvas.wrap, {
    getDoc: () => doc,
    getLayout: () => canvas.getLayout(),
    getSelection: () => selection,
    getViewportSize: () => ({ w: view.width, h: view.height }),
    edit,
    pickResource: (type) => pickResource(type),
    describeResource: (raw) => {
      const m = /^ExtResource\("?(.+?)"?\)$/.exec(String(raw));
      if (m) {
        const sec = doc.sections.find((s) => s.tag === 'ext_resource' && attrStr(s, 'id') === m[1]);
        const p = sec && attrStr(sec, 'path');
        return p ? p.split('/').pop() : raw;
      }
      const sub = /^SubResource\("?(.+?)"?\)$/.exec(String(raw));
      if (sub) {
        const sec = doc.sections.find((s) => s.tag === 'sub_resource' && attrStr(s, 'id') === sub[1]);
        return sec ? attrStr(sec, 'type') : raw;
      }
      return String(raw);
    },
    // Called from inside an edit transaction, on that transaction's document.
    newStyleBox: (target) => `SubResource("${addSubResource(target || doc, 'StyleBoxFlat', [
      { key: 'bg_color', value: 'Color(0.15, 0.15, 0.18, 1)' },
    ])}")`,
    editStyleBox: () => setStatus('Edit the StyleBox in the Code view for now'),
  });

  // --- resource picker (textures) ---
  let textureList = null;
  const loadTextures = async () => {
    if (textureList) return textureList;
    const r = await filesPromise;
    textureList = r && r.ok ? textureEntries(file, r.files) : [];
    return textureList;
  };

  // A modal-ish popup listing the project's images; resolves to the
  // `ExtResource("id")` string to write (the resource is deduped by path).
  const pickResource = async (type) => {
    const entries = await loadTextures();
    if (!entries.length) { setStatus('No images in this project'); return undefined; }
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'uis-picker-scrim';
      const box = document.createElement('div');
      box.className = 'uis-picker-box';
      const head = document.createElement('div');
      head.className = 'uis-picker-head';
      head.textContent = `Choose a ${type}`;
      const grid = document.createElement('div');
      grid.className = 'uis-picker-grid';
      for (const entry of entries) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'scene-res-card';
        card.title = entry.file;
        const thumb = document.createElement('div');
        thumb.className = 'scene-res-thumb';
        window.api.readAsset(entry.file).then((r) => {
          if (!r || !r.ok) return;
          const img = new Image();
          img.src = `data:${r.mime};base64,${r.base64}`;
          thumb.appendChild(img);
        });
        const label = document.createElement('span');
        label.className = 'scene-res-name';
        label.textContent = entry.name;
        card.append(thumb, label);
        card.addEventListener('click', () => {
          close(`ExtResource("${addExtResource(doc, { type: 'Texture2D', path: entry.res })}")`);
        });
        grid.appendChild(card);
      }
      const cancel = assetBtn('Cancel', () => close(undefined));
      box.append(head, grid, cancel);
      scrim.appendChild(box);
      scrim.addEventListener('click', (e) => { if (e.target === scrim) close(undefined); });
      body.appendChild(scrim);
      function close(value) { scrim.remove(); resolve(value); }
    });
  };

  // --- structural edits ---
  const parentForInsert = () => {
    const sel = selection[0];
    if (!sel) return '.';
    return sel;
  };

  const addNodeOfType = (type) => {
    const parentPath = parentForInsert();
    let newPath = null;
    edit(`add:${type}`, (d) => {
      const name = uniqueChildName(d, parentPath, type);
      const node = addNode(d, { parentPath, type, name });
      newPath = nodePathOf(node);
      const parentType = attrStr(findNode(d, parentPath), 'type');
      if (isContainerType(parentType)) { setProp(node, 'layout_mode', '2'); return; }
      const [w, h] = DEFAULT_SIZE[type] || [120, 60];
      writeRect(d, newPath, { anchors: [0, 0, 0, 0], offsets: [0, 0, w, h] });
      if (type === 'Label' || type === 'Button') setProp(node, 'text', quote(type));
    });
    if (newPath) setSelection([newPath]);
  };

  const deleteSelected = () => {
    const targets = selection.filter((p) => p !== '.');
    if (!targets.length) return;
    edit('delete', (d) => { for (const p of targets) if (findNode(d, p)) removeNodeTree(d, p); });
    setSelection([]);
  };

  const duplicateSelected = () => {
    const targets = selection.filter((p) => p !== '.');
    if (!targets.length) return;
    const made = [];
    edit('duplicate', (d) => { for (const p of targets) made.push(duplicateNode(d, p)); });
    setSelection(made);
  };

  const reorder = (delta) => {
    if (selection.length !== 1 || selection[0] === '.') return;
    edit(`reorder:${selection[0]}`, (d) => moveSibling(d, selection[0], delta));
  };

  const nudge = (dx, dy) => {
    const targets = selection.filter((p) => {
      const info = canvas.getLayout().get(p);
      return info && !info.managed && p !== '.';
    });
    if (!targets.length) return;
    edit('nudge', (d) => {
      for (const p of targets) {
        const node = findNode(d, p);
        const anchors = anchorsOf(node);
        const info = canvas.getLayout().get(p);
        const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
        const parent = canvas.getLayout().get(parentPath);
        const origin = parent ? parent.rect : { x: 0, y: 0 };
        const size = parent ? { w: parent.rect.w, h: parent.rect.h } : { w: view.width, h: view.height };
        const local = { x: info.rect.x - origin.x + dx, y: info.rect.y - origin.y + dy, w: info.rect.w, h: info.rect.h };
        writeRect(d, p, { anchors, offsets: offsetsForRect(local, anchors, size) });
      }
    });
  };

  // --- add-node dock ---
  const dock = document.createElement('div');
  dock.className = 'model-edit-panel uis-add-dock';
  const dockHead = document.createElement('button');
  dockHead.className = 'model-tree-head';
  dockHead.title = 'Toggle the node palette';
  dockHead.innerHTML = '<span class="model-tree-caret">▾</span><span class="model-tree-title">Add node</span>';
  dockHead.addEventListener('click', () => dock.classList.toggle('collapsed'));
  const dockBody = document.createElement('div');
  dockBody.className = 'model-edit-body';
  for (const [group, types] of ADDABLE) {
    const sec = document.createElement('div');
    sec.className = 'model-edit-section';
    const title = document.createElement('div');
    title.className = 'model-edit-section-title';
    title.textContent = group;
    const list = document.createElement('div');
    list.className = 'uis-add-list';
    for (const type of types) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-add-item';
      item.textContent = type;
      item.title = `Add a ${type} under the selected node`;
      item.addEventListener('click', () => addNodeOfType(type));
      list.appendChild(item);
    }
    sec.append(title, list);
    dockBody.appendChild(sec);
  }
  dock.append(dockHead, dockBody);
  dock.classList.add('collapsed');
  canvas.wrap.appendChild(dock);

  // --- texture strip: drag an image into the canvas to add a TextureRect ---
  const buildResourcePanel = async () => {
    const entries = await loadTextures();
    if (!entries.length || disposed) return;
    const panel = document.createElement('div');
    panel.className = 'scene-res-panel uis-res-panel collapsed';
    const head = document.createElement('button');
    head.className = 'model-tree-head';
    head.title = 'Toggle textures panel';
    head.innerHTML = '<span class="model-tree-caret">▾</span>'
      + `<span class="model-tree-title">Textures (${entries.length})</span>`;
    head.addEventListener('click', () => panel.classList.toggle('collapsed'));
    const strip = document.createElement('div');
    strip.className = 'scene-res-strip';
    panel.append(head, strip);
    for (const entry of entries) {
      const card = document.createElement('div');
      card.className = 'scene-res-card';
      card.draggable = true;
      card.title = `${entry.file} — drag into the canvas`;
      const thumb = document.createElement('div');
      thumb.className = 'scene-res-thumb';
      window.api.readAsset(entry.file).then((r) => {
        if (!r || !r.ok || disposed) return;
        const img = new Image();
        img.src = `data:${r.mime};base64,${r.base64}`;
        thumb.appendChild(img);
      });
      const label = document.createElement('span');
      label.className = 'scene-res-name';
      label.textContent = entry.name;
      card.append(thumb, label);
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(TEXTURE_MIME, entry.res);
        e.dataTransfer.setData('text/plain', entry.file);
        e.dataTransfer.effectAllowed = 'copy';
      });
      strip.appendChild(card);
    }
    canvas.wrap.appendChild(panel);
  };
  buildResourcePanel();

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes(TEXTURE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e) => {
    const res = e.dataTransfer.getData(TEXTURE_MIME);
    if (!res) return;
    e.preventDefault();
    const parentPath = parentForInsert();
    let newPath = null;
    edit('drop-texture', (d) => {
      const id = addExtResource(d, { type: 'Texture2D', path: res });
      const base = nodeNameFor(res.split('/').pop().replace(/\.[^.]+$/, ''));
      const name = uniqueChildName(d, parentPath, base);
      const node = addNode(d, { parentPath, type: 'TextureRect', name });
      newPath = nodePathOf(node);
      setProp(node, 'texture', `ExtResource("${id}")`);
      if (isContainerType(attrStr(findNode(d, parentPath), 'type'))) setProp(node, 'layout_mode', '2');
      else writeRect(d, newPath, { anchors: [0, 0, 0, 0], offsets: [0, 0, 128, 128] });
    });
    if (newPath) setSelection([newPath]);
  };
  canvas.wrap.addEventListener('dragover', onDragOver);
  canvas.wrap.addEventListener('drop', onDrop);

  // --- save ---
  async function save() {
    if (!dirty || saving) return;
    saving = true; refreshSave(); setStatus('Saving…');
    const r = await window.api.writeText(file, serializeTscn(doc));
    saving = false;
    if (r.ok) { dirty = false; setStatus('Saved'); refreshGit(); }
    else setStatus(r.error || 'Save failed');
    refreshSave();
  }

  // --- keyboard ---
  const onKey = (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === 'd' && !typing) { e.preventDefault(); duplicateSelected(); }
      else if (k === '0') { e.preventDefault(); canvas.zoomToFit(); }
      else if (k === '=' || k === '+') { e.preventDefault(); canvas.setZoom(canvas.getZoom() * 1.25); }
      else if (k === '-') { e.preventDefault(); canvas.setZoom(canvas.getZoom() / 1.25); }
      return;
    }
    if (typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'F2') {
      e.preventDefault();
      if (selection.length === 1 && selection[0] !== '.') startRenameFor(outliner, selection[0]);
    } else if (e.key === 'Escape') setSelection([]);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.altKey) reorder(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0);
      else nudge(
        (e.key === 'ArrowRight' ? step : 0) - (e.key === 'ArrowLeft' ? step : 0),
        (e.key === 'ArrowDown' ? step : 0) - (e.key === 'ArrowUp' ? step : 0),
      );
    }
  };
  document.addEventListener('keydown', onKey, true);

  // The viewport size arrives with project.godot; re-fit once it does.
  projectReady.then(() => { if (!disposed) { canvas.refresh(); canvas.zoomToFit(); } });

  setSelection(['.']);
  refreshSave();

  registerCleanup(() => {
    disposed = true;
    document.removeEventListener('keydown', onKey, true);
    canvas.wrap.removeEventListener('dragover', onDragOver);
    canvas.wrap.removeEventListener('drop', onDrop);
    inspector.destroy();
    outliner.destroy();
    canvas.destroy();
  });
}
