import { diffBody, setDiffTitle, showDiffContainer } from './code-render.js';
import { langFor, hlLines } from '../shared/highlight.js';

// Read-only file view for the explorer: reuse the diff container, render each
// line with a single line-number gutter (no +/- colouring). `jump`
// (optional { line, term }) scrolls to that line and marks the matched word.
// Peer overlays / session terminals are hidden by the center coordinator first.
export async function showFile(file, jump) {
  const r = await window.api.readText(file);
  setDiffTitle(file);
  let text = r.ok ? r.text : (r.error || '(could not read)');
  let lang = langFor(file);
  if (!r.ok || text.includes('\\u0000')) {   // can't highlight an error or binary
    if (r.ok) text = '(binary file)';         // ponytail: null-byte sniff is enough
    lang = null;
  }
  renderText(text, lang);
  showDiffContainer();
  if (jump) jumpToLine(jump.line, jump.term);
}

// Scroll a reference hit into view and visually mark the matched word inside it.
function jumpToLine(line, term) {
  const row = diffBody.children[(line || 1) - 1];
  if (!row) return;
  row.classList.add('diff-hit');
  if (term) markTerm(row.querySelector('.diff-code'), term);
  row.scrollIntoView({ block: 'center' });
}

// Wrap each case-insensitive occurrence of `term` in <mark>, walking text nodes
// so we don't disturb hljs's existing <span> structure.
function markTerm(el, term) {
  if (!el || !term) return;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.toLowerCase().includes(needle)) nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.nodeValue, low = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0, idx;
    while ((idx = low.indexOf(needle, i)) !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      i = idx + needle.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderText(text, lang) {
  diffBody.innerHTML = '';
  // ponytail: cap render at 5000 lines; virtualize only if huge files matter
  const lines = text.split('\n').slice(0, 5000);
  // Known extension -> that grammar; null lang -> hlLines auto-detects.
  const hl = hlLines(lines.join('\n'), lang);
  let n = 1;
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'diff-row';
    const ln = document.createElement('span');
    ln.className = 'diff-ln';
    ln.textContent = n++;
    const code = document.createElement('span');
    code.className = 'diff-code';
    if (hl && hl[i] != null) code.innerHTML = hl[i]; else code.textContent = lines[i];
    row.append(ln, code);
    diffBody.appendChild(row);
  }
}
