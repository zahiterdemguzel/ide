import { renderZoom } from './zoom.js';
import { assetBtn } from './ui.js';
import { base64ToText } from '../../shared/base64.js';
import { aiInfo } from '../../shared/svg-ops.js';

// Read-only preview for vector files + the entry into the editor.
//  - SVG: a pan/zoom preview of the rendered image (reusing the image zoom view),
//    plus an "Edit" button (only when onEdit is supplied) that enters the paper.js
//    editor. No paper.js is loaded for the preview itself.
//  - .ai: view-only. Modern .ai wraps a PDF, legacy is PostScript — neither is
//    editable as paths in-browser — so we show an info card and rely on the header's
//    "Open externally" to hand it to Illustrator/Acrobat.
export function renderVectorView(file, base64, ext, body, tools, registerSub, onEdit) {
  if (ext === 'ai') { renderAiCard(base64, body); return; }

  const img = new Image();
  img.onload = () => {
    renderZoom(img, body, tools, registerSub, null);
    if (onEdit) {
      const edit = assetBtn('Edit', onEdit);
      edit.title = 'Edit this SVG — draw paths, shapes, booleans, layers…';
      tools.append(edit);
    }
  };
  img.onerror = () => { body.textContent = 'Could not render SVG preview'; };
  img.src = `data:image/svg+xml;base64,${base64}`;
}

function renderAiCard(base64, body) {
  // Decode only the head — enough for the magic bytes and metadata comments.
  let head = '';
  try { head = base64ToText(base64).slice(0, 4096); } catch { head = ''; }
  const info = aiInfo(head);
  const kindLabel =
    info.kind === 'pdf' ? 'PDF-based (modern Illustrator)' :
    info.kind === 'postscript' ? 'PostScript / EPS (legacy Illustrator)' :
    'Adobe Illustrator';

  const card = document.createElement('div');
  card.className = 'vector-info-card';

  const icon = document.createElement('div');
  icon.className = 'vector-info-icon';
  icon.textContent = 'AI';
  const title = document.createElement('h2');
  title.className = 'vector-info-title';
  title.textContent = 'Adobe Illustrator file';
  const note = document.createElement('p');
  note.className = 'vector-info-note';
  note.textContent = "View-only preview. Illustrator files can't be edited as vector paths "
    + 'in-app (modern .ai wraps a PDF, legacy is PostScript). Use "Open externally" above to '
    + 'edit in Illustrator, or export to .svg there for full editing here.';

  const grid = document.createElement('dl');
  grid.className = 'vector-info-grid';
  const rows = [
    ['Type', kindLabel],
    info.version ? ['Version', info.version] : null,
    info.creator ? ['Creator', info.creator] : null,
    (info.width && info.height) ? ['Size', `${info.width} × ${info.height} pt`] : null,
  ].filter(Boolean);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    grid.append(dt, dd);
  }

  card.append(icon, title, note, grid);
  body.appendChild(card);
}
