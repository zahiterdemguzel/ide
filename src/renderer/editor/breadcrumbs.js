// Breadcrumbs in the editor head: the file's folders, its name, then the
// symbols containing the caret (class › method), as in VS Code. Symbols come
// from the language server's documentSymbol (lsp-client.js); without a server
// the trail stops at the file name. Clicking a symbol jumps to it; clicking a
// folder reveals it in the explorer.

import { symbolPathAt } from './symbol-path.js';

const el = document.getElementById('diff-file');

let callbacks = null;
let symbolCache = { model: null, version: -1, symbols: null };
let refreshTimer = null;
let request = 0;

// Monaco SymbolKind → a small letter badge + colour class (no icon font needed).
const KIND_GLYPH = {
  1: ['M', 'mod'], 2: ['N', 'mod'], 3: ['P', 'mod'],
  4: ['C', 'cls'], 22: ['S', 'cls'], 9: ['E', 'enum'], 21: ['e', 'enum'], 10: ['I', 'iface'], 25: ['T', 'iface'],
  5: ['m', 'fn'], 8: ['c', 'fn'], 11: ['ƒ', 'fn'], 24: ['o', 'fn'],
  6: ['p', 'field'], 7: ['f', 'field'], 19: ['k', 'field'], 23: ['⚡', 'field'],
  12: ['v', 'var'], 13: ['K', 'var'], 17: ['a', 'var'], 18: ['o', 'var'],
};

// cb = { getSymbols(model) → Promise<tree|null>, revealRange(range), revealFolder(path) }
export function initBreadcrumbs(cb) { callbacks = cb; }

function part(text, cls, onClick) {
  const span = document.createElement(onClick ? 'button' : 'span');
  span.className = `bc-part ${cls || ''}`;
  span.textContent = text;
  if (onClick) { span.type = 'button'; span.addEventListener('click', onClick); }
  return span;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'bc-sep';
  s.textContent = '›';
  return s;
}

// Render the trail for `file` with the caret at `position` in `model`.
export function renderBreadcrumbs(file, model, position, { dirty = false } = {}) {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || file;
  const nodes = [];
  let acc = file.startsWith('/') ? '/' : '';
  for (const folder of parts) {
    acc += (acc && !acc.endsWith('/') ? '/' : '') + folder;
    const target = acc;
    nodes.push(part(folder, 'bc-folder', () => callbacks.revealFolder(target)), sep());
  }
  nodes.push(part(name + (dirty ? ' •' : ''), 'bc-file'));
  const symbols = symbolCache.model === model && symbolCache.version === model.getVersionId() ? symbolCache.symbols : null;
  if (symbols && position) {
    for (const sym of symbolPathAt(symbols, position.lineNumber, position.column)) {
      const [glyph, cls] = KIND_GLYPH[sym.kind] || ['•', 'var'];
      const btn = part(sym.name, 'bc-symbol', () => callbacks.revealRange(sym.selectionRange || sym.range));
      const icon = document.createElement('span');
      icon.className = `bc-kind ${cls}`;
      icon.textContent = glyph;
      btn.prepend(icon);
      nodes.push(sep(), btn);
    }
  }
  el.replaceChildren(...nodes);
  el.title = file;
  if (model && (symbolCache.model !== model || symbolCache.version !== model.getVersionId())) scheduleSymbols(file, model);
}

function scheduleSymbols(file, model) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const id = ++request;
    const version = model.getVersionId();
    let symbols = null;
    try { symbols = await callbacks.getSymbols(model); } catch { symbols = null; }
    if (id !== request || model.isDisposed()) return;
    symbolCache = { model, version, symbols };
    if (symbols) renderBreadcrumbs(file, model, callbacks.currentPosition(), { dirty: callbacks.isDirty() });
  }, 350);
}

// Plain title (diff view, notices) — no trail.
export function setPlainTitle(text) {
  clearTimeout(refreshTimer);
  el.replaceChildren(document.createTextNode(text));
  el.title = '';
}
