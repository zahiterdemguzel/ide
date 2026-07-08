import { parseIco, extractFrame, describeEntry } from '../../shared/ico-parse.js';
import { renderZoom } from './zoom.js';
import { assetBtn } from './ui.js';

// .ico preview: an icon file bundles several independently-encoded frames
// (16px…256px, PNG or BMP), and a plain <img> shows only whichever one
// Chromium picks. This view parses the container and shows every frame — a
// grid of cards labelled with size / bit depth / encoding — and clicking a
// card opens that exact frame in the shared zoom view. Frames are displayed
// by repackaging each one as a single-image .ico blob so Chromium's decoder
// handles both PNG and BMP frames.

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function renderIcoView(file, base64, body, tools, registerCleanup) {
  const bytes = base64ToBytes(base64);
  let parsed;
  try {
    parsed = parseIco(bytes);
  } catch {
    // Mislabelled .ico (often a renamed PNG): let <img> have a go at the raw bytes.
    renderFallback(base64, body, tools, registerCleanup);
    return;
  }

  const viewTools = document.createElement('span');
  viewTools.className = 'asset-view-tools';
  tools.insertBefore(viewTools, tools.firstChild);

  const urls = parsed.entries.map((e) => {
    const frame = extractFrame(bytes, e);
    return URL.createObjectURL(new Blob([frame.bytes], { type: frame.mime }));
  });

  let subCleanup = null;
  const registerSub = (fn) => { subCleanup = fn; };
  const clear = () => {
    if (subCleanup) { subCleanup(); subCleanup = null; }
    viewTools.innerHTML = '';
    body.innerHTML = '';
  };

  const showGrid = () => {
    clear();
    const view = document.createElement('div');
    view.className = 'ico-view';

    const summary = document.createElement('div');
    summary.className = 'ico-summary';
    const kind = parsed.type === 'cursor' ? 'Windows cursor' : 'Windows icon';
    summary.textContent = `${kind} · ${parsed.entries.length} ${parsed.entries.length === 1 ? 'image' : 'images'} · ${bytes.length.toLocaleString()} bytes`;
    view.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'ico-grid';
    parsed.entries.forEach((entry, i) => {
      const card = document.createElement('button');
      card.className = 'ico-card';
      card.title = 'Click to zoom this size';
      const thumb = document.createElement('span');
      thumb.className = 'ico-thumb';
      const img = document.createElement('img');
      img.src = urls[i];
      img.alt = describeEntry(entry);
      img.onerror = () => { thumb.textContent = 'decode failed'; thumb.classList.add('ico-thumb-err'); };
      thumb.appendChild(img);
      const label = document.createElement('span');
      label.className = 'ico-label';
      label.textContent = describeEntry(entry);
      card.append(thumb, label);
      card.onclick = () => showFrame(entry, urls[i]);
      grid.appendChild(card);
    });
    view.appendChild(grid);
    body.appendChild(view);
  };

  const showFrame = (entry, url) => {
    clear();
    const back = assetBtn('All sizes', showGrid);
    back.title = 'Back to every size in this icon';
    viewTools.appendChild(back);
    const img = new Image();
    img.onload = () => renderZoom(img, body, viewTools, registerSub, null);
    img.onerror = () => { body.textContent = `Could not decode the ${describeEntry(entry)} image`; };
    img.src = url;
  };

  registerCleanup(() => {
    if (subCleanup) subCleanup();
    urls.forEach((u) => URL.revokeObjectURL(u));
  });
  showGrid();
}

function renderFallback(base64, body, tools, registerCleanup) {
  const viewTools = document.createElement('span');
  viewTools.className = 'asset-view-tools';
  tools.insertBefore(viewTools, tools.firstChild);
  const img = new Image();
  img.onload = () => renderZoom(img, body, viewTools, registerCleanup, null);
  img.onerror = () => { body.textContent = 'Could not decode image'; };
  img.src = `data:image/x-icon;base64,${base64}`;
}
