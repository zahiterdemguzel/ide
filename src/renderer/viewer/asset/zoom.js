import { assetBtn } from './ui.js';

// Image zoom view: an <img> with −/+/reset buttons scaling its width.
// `body`/`tools` are the asset view's body and toolbar containers.
export function renderZoom(img, body, tools) {
  let scale = 1;
  img.className = 'zoom-img';
  const wrap = document.createElement('div');
  wrap.className = 'zoom-wrap';
  wrap.appendChild(img);
  body.appendChild(wrap);

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
    assetBtn('Reset', () => { scale = 1; apply(); }),
  );
  apply();
}
