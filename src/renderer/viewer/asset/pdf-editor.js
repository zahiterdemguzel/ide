import { assetBtn } from './ui.js';
import { openPdf, renderPageCanvas } from './pdf-doc.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../../shared/base64.js';
import { makePages, rotatePage, deletePage, movePage, isIdentity } from '../../shared/pdf-ops.js';
import { refreshGit } from '../../git-pane.js';

// Page-level PDF editor: a grid of page thumbnails (rendered once by pdf.js)
// edited through the pure page-list model in shared/pdf-ops.js — rotate,
// delete, and reorder (buttons or drag-and-drop). Nothing touches the document
// until Save, which builds a fresh PDF with pdf-lib (copyPages in the edited
// order, rotation deltas applied) and writes it back over write-asset. Undo is
// a snapshot stack of the (immutable) page lists. Content-level editing (text,
// images) is out of scope — this is page assembly, not authoring.
const THUMB_WIDTH = 150;

export async function renderPdfEditor(file, base64, body, tools, registerSub, onSaved) {
  const doc = await openPdf(base64);
  const pageCount = doc.numPages;

  // Thumbnails are keyed by *source* page index and rendered once — reordering
  // or rotating only moves/transforms the cached canvas, never re-renders.
  const thumbs = [];
  for (let n = 1; n <= pageCount; n++) {
    thumbs.push(await renderPageCanvas(await doc.getPage(n), THUMB_WIDTH));
  }
  doc.destroy();

  let pages = makePages(pageCount);
  let selected = 0;
  const undoStack = [];
  const redoStack = [];

  const grid = document.createElement('div');
  grid.className = 'pdf-edit-grid';
  body.appendChild(grid);

  const saveBtn = assetBtn('Save', save);
  saveBtn.title = 'Save the edited PDF (Ctrl+S)';
  const rotL = assetBtn('⟲', () => apply(rotatePage(pages, selected, -90)));
  rotL.title = 'Rotate the selected page 90° counter-clockwise';
  const rotR = assetBtn('⟳', () => apply(rotatePage(pages, selected, 90)));
  rotR.title = 'Rotate the selected page 90° clockwise';
  const del = assetBtn('Delete', () => apply(deletePage(pages, selected)));
  del.title = 'Delete the selected page';
  const back = assetBtn('Done', () => onSaved(base64));
  back.title = 'Back to the PDF preview';
  tools.append(rotL, rotR, del, saveBtn, back);

  function apply(next) {
    if (next === pages) return; // op was a no-op (bounds / last page)
    undoStack.push(pages);
    redoStack.length = 0;
    pages = next;
    if (selected >= pages.length) selected = pages.length - 1;
    paint();
  }

  function paint() {
    grid.innerHTML = '';
    pages.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'pdf-thumb' + (i === selected ? ' selected' : '');
      card.draggable = true;
      const frame = document.createElement('div');
      frame.className = 'pdf-thumb-frame';
      const canvas = thumbs[p.src];
      canvas.style.transform = p.rotation ? `rotate(${p.rotation}deg)` : '';
      frame.appendChild(canvas);
      const cap = document.createElement('div');
      cap.className = 'pdf-thumb-cap';
      cap.textContent = p.src === i && !p.rotation ? `${i + 1}` : `${i + 1} (was ${p.src + 1})`;
      card.append(frame, cap);
      card.onclick = () => { selected = i; paint(); };
      card.ondragstart = (e) => { selected = i; paint(); e.dataTransfer.setData('text/plain', String(i)); };
      card.ondragover = (e) => e.preventDefault();
      card.ondrop = (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) { apply(movePage(pages, from, i)); selected = i; paint(); }
      };
      grid.appendChild(card);
    });
    const dirty = !isIdentity(pages, pageCount);
    saveBtn.disabled = !dirty;
    saveBtn.textContent = dirty ? 'Save •' : 'Save';
    del.disabled = pages.length <= 1;
  }

  async function save() {
    if (isIdentity(pages, pageCount)) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const { PDFDocument, degrees } = await import('pdf-lib');
      const src = await PDFDocument.load(base64ToArrayBuffer(base64));
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, pages.map((p) => p.src));
      copied.forEach((page, i) => {
        const delta = pages[i].rotation;
        if (delta) page.setRotation(degrees((page.getRotation().angle + delta) % 360));
        out.addPage(page);
      });
      const bytes = await out.save();
      const out64 = arrayBufferToBase64(bytes);
      const r = await window.api.writeAsset(file, out64);
      if (!r.ok) throw new Error(r.error || 'write failed');
      refreshGit();
      onSaved(out64); // back to the preview over the saved bytes
    } catch (e) {
      saveBtn.textContent = 'Save failed';
      saveBtn.disabled = false;
      console.error('PDF save failed:', e);
    }
  }

  function undo() { if (undoStack.length) { redoStack.push(pages); pages = undoStack.pop(); if (selected >= pages.length) selected = pages.length - 1; paint(); } }
  function redo() { if (redoStack.length) { undoStack.push(pages); pages = redoStack.pop(); if (selected >= pages.length) selected = pages.length - 1; paint(); } }

  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Delete') { e.preventDefault(); apply(deletePage(pages, selected)); }
    else if (e.key === 'ArrowLeft' && selected > 0) { selected--; paint(); }
    else if (e.key === 'ArrowRight' && selected < pages.length - 1) { selected++; paint(); }
  };
  document.addEventListener('keydown', onKey);

  registerSub(() => document.removeEventListener('keydown', onKey));
  paint();
}
