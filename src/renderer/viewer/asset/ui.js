// Small shared toolbar-button factory for the asset views.
export function assetBtn(text, onclick) {
  const b = document.createElement('button');
  b.className = 'asset-btn';
  b.textContent = text;
  b.onclick = onclick;
  return b;
}
