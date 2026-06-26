import { assetBtn } from './ui.js';

// Image zoom view: an <img> with −/+/reset buttons scaling its width.
// `body`/`tools` are the asset view's body and toolbar containers.
export function renderZoom(img, body, tools) {
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
}
