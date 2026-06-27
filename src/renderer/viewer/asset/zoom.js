import { assetBtn } from './ui.js';

// Image zoom view: an <img> with −/+/reset buttons scaling its width.
// `body`/`tools` are the asset view's body and toolbar containers.
// `registerCleanup` removes the document-level pan listeners when the view closes.
export function renderZoom(img, body, tools, registerCleanup) {
  img.className = 'zoom-img';
  const wrap = document.createElement('div');
  wrap.className = 'zoom-wrap';
  wrap.appendChild(img);
  body.appendChild(wrap);

  // Start fit-to-view: scale the image down so it fits the viewport, but never
  // up past 100% — so a 4K screenshot opens fully visible instead of zoomed in,
  // while a small image stays at its natural size.
  const fitScale = () => {
    const cs = getComputedStyle(body);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = body.clientWidth - padX;
    const availH = body.clientHeight - padY;
    if (availW <= 0 || availH <= 0) return 1;
    return Math.min(1, availW / img.naturalWidth, availH / img.naturalHeight);
  };

  let scale = fitScale();

  const pct = document.createElement('span');
  pct.className = 'asset-pct';
  const apply = () => {
    img.style.width = (img.naturalWidth * scale) + 'px';
    pct.textContent = Math.round(scale * 100) + '%';
  };
  tools.append(
    assetBtn('−', () => { scale = Math.max(0.1, scale / 1.25); apply(); }),
    pct,
    assetBtn('+', () => { scale = Math.min(32, scale * 1.25); apply(); }),
    assetBtn('Reset', () => { scale = fitScale(); apply(); }),
  );
  apply();

  // Left-button drag pans the image by scrolling the body — useful once a zoomed
  // image overflows the viewport. Move/up live on the document so the drag keeps
  // tracking even when the cursor leaves the image.
  let panning = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  const onMove = (e) => {
    if (!panning) return;
    body.scrollLeft = startLeft - (e.clientX - startX);
    body.scrollTop = startTop - (e.clientY - startY);
    e.preventDefault();
  };
  const onUp = () => { panning = false; body.classList.remove('panning'); };
  const onDown = (e) => {
    if (e.button !== 0) return;
    panning = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = body.scrollLeft; startTop = body.scrollTop;
    body.classList.add('panning');
    e.preventDefault();
  };
  img.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  registerCleanup?.(() => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    body.classList.remove('panning');
  });
}
