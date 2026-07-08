import { assetBtn } from './ui.js';
import { openPdf, renderPageCanvas } from './pdf-doc.js';

// Read-only PDF preview: every page rendered by pdf.js as a canvas in a
// vertical scroll, with −/+/reset zoom and a page-count readout. Pages render
// sequentially so the first page appears immediately even in a long document.
// An Edit button hands off to the page-level editor (pdf-editor.js).
export async function renderPdfView(base64, body, tools, registerSub, onEdit) {
  const doc = await openPdf(base64);

  const container = document.createElement('div');
  container.className = 'pdf-pages';
  body.appendChild(container);

  let zoom = 1;
  let renderToken = 0;
  let destroyed = false;

  const label = document.createElement('span');
  label.className = 'asset-note';
  label.textContent = doc.numPages === 1 ? '1 page' : `${doc.numPages} pages`;

  // Fit the page width to the pane at zoom 1, with a sane floor/ceiling.
  const baseWidth = () => Math.min(Math.max(body.clientWidth - 48, 320), 1200);

  async function renderAll() {
    const token = ++renderToken;
    container.innerHTML = '';
    const width = baseWidth() * zoom;
    for (let n = 1; n <= doc.numPages; n++) {
      let canvas;
      try {
        canvas = await renderPageCanvas(await doc.getPage(n), width);
      } catch (e) {
        if (destroyed || token !== renderToken) return;
        const err = document.createElement('div');
        err.textContent = `Could not render page ${n}: ` + (e && e.message ? e.message : e);
        container.appendChild(err);
        continue;
      }
      if (destroyed || token !== renderToken) return; // superseded by a newer zoom
      canvas.className = 'pdf-page';
      container.appendChild(canvas);
    }
  }

  const setZoom = (z) => { zoom = Math.min(Math.max(z, 0.25), 4); renderAll(); };
  tools.append(
    label,
    assetBtn('−', () => setZoom(zoom / 1.25)),
    assetBtn('+', () => setZoom(zoom * 1.25)),
    assetBtn('Reset', () => setZoom(1)),
  );
  if (onEdit) {
    const edit = assetBtn('Edit', onEdit);
    edit.title = 'Edit pages — rotate, delete, reorder';
    tools.append(edit);
  }

  registerSub(() => { destroyed = true; renderToken++; doc.destroy(); });
  await renderAll();
}
