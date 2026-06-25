import { diffBody, setDiffTitle, showDiffContainer } from './code-render.js';
import { langFor, hlLines } from '../shared/highlight.js';

let currentFile = null;
let currentText = '';
let editMode = false;

const editBtn = document.getElementById('diff-edit');
const saveBtn = document.getElementById('diff-save');

// Show a file from the explorer. `jump` (optional { line, term }) scrolls to
// that line and marks the matched word. Resets any active edit mode.
export async function showFile(file, jump) {
  const r = await window.api.readText(file);
  currentFile = file;
  setDiffTitle(file);
  let text = r.ok ? r.text : (r.error || '(could not read)');
  let lang = langFor(file);
  const isBinary = r.ok && text.indexOf('\x00') !== -1;
  const canEdit = r.ok && !isBinary;
  if (!canEdit) {
    if (r.ok) text = '(binary file)';
    lang = null;
  }
  currentText = text;
  editMode = false;
  editBtn.hidden = !canEdit;
  saveBtn.hidden = true;
  renderText(text, lang);
  showDiffContainer();
  if (jump) jumpToLine(jump.line, jump.term);
}

// Hide edit/save buttons — called by center when showing a diff instead of a file.
export function hideFileButtons() {
  editBtn.hidden = true;
  saveBtn.hidden = true;
  editMode = false;
  currentFile = null;
}

editBtn.addEventListener('click', () => {
  editMode = true;
  editBtn.hidden = true;
  saveBtn.hidden = false;
  diffBody.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.id = 'file-edit-area';
  ta.value = currentText;
  ta.spellcheck = false;
  diffBody.appendChild(ta);
  ta.focus();
});

saveBtn.addEventListener('click', () => saveFile());

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && editMode && currentFile) {
    e.preventDefault();
    saveFile();
  }
});

async function saveFile() {
  if (!currentFile || !editMode) return;
  const ta = document.getElementById('file-edit-area');
  if (!ta) return;
  const text = ta.value;
  const r = await window.api.writeText(currentFile, text);
  if (!r.ok) {
    console.error('Save failed:', r.error);
    return;
  }
  currentText = text;
  editMode = false;
  editBtn.hidden = false;
  saveBtn.hidden = true;
  renderText(text, langFor(currentFile));
}

function jumpToLine(line, term) {
  const row = diffBody.children[(line || 1) - 1];
  if (!row) return;
  row.classList.add('diff-hit');
  if (term) markTerm(row.querySelector('.diff-code'), term);
  row.scrollIntoView({ block: 'center' });
}

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
