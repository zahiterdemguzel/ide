// Quick Open palette (Ctrl/Cmd+P): a centered, keyboard-driven fuzzy file
// switcher — the IDE staple for jumping to a file without touching the tree. It
// fetches the repo's flat file list once per open (list-files) and fuzzy-matches
// client-side as you type (renderer/shared/fuzzy.js), so every keystroke is
// instant with no IPC. Enter opens the highlighted file through the same
// openFromTree() the tree and search use; ↑/↓ move, Esc/backdrop dismiss.
import { fuzzyFilter } from './shared/fuzzy.js';
import { fileColor } from './shared/ext.js';
import { openFromTree } from './viewer/center.js';
import { t } from '../i18n/index.js';

const MAX_ROWS = 100;

let backdrop = null;   // the open palette, or null when closed
let files = [];        // the repo's flat file list for this open
let results = [];      // current filtered + ranked rows ({ item, positions })
let active = 0;        // index of the highlighted row
let input, list;

function dirName(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }

// Build the file path with the fuzzy-matched characters wrapped in <b>. Positions
// index the whole path; we render the dir dimmed and the basename in its ext
// colour, both inheriting the same highlight marks.
function highlighted(item, positions) {
  const set = new Set(positions);
  const frag = document.createDocumentFragment();
  const dirLen = dirName(item).length;
  const dir = document.createElement('span');
  dir.className = 'qo-dir';
  const name = document.createElement('span');
  name.className = 'qo-name';
  name.style.color = fileColor(item);
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    const node = set.has(i)
      ? Object.assign(document.createElement('b'), { textContent: ch })
      : document.createTextNode(ch);
    (i < dirLen ? dir : name).appendChild(node);
  }
  if (dirLen) frag.appendChild(dir);
  frag.appendChild(name);
  return frag;
}

function render() {
  list.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = files.length ? t('quickOpen.noMatches') : t('quickOpen.empty');
    list.appendChild(empty);
    return;
  }
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'qo-row' + (i === active ? ' active' : '');
    row.title = r.item;
    row.appendChild(highlighted(r.item, r.positions));
    row.onmousemove = () => setActive(i);
    row.onclick = () => choose(i);
    list.appendChild(row);
  });
}

function setActive(i) {
  if (i === active) return;
  active = i;
  const rows = list.children;
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === active);
  rows[active]?.scrollIntoView({ block: 'nearest' });
}

function move(delta) {
  if (!results.length) return;
  setActive((active + delta + results.length) % results.length);
}

function update() {
  results = fuzzyFilter(input.value, files, MAX_ROWS);
  active = 0;
  render();
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  close();
  openFromTree(r.item);
}

function close() {
  if (!backdrop) return;
  window.removeEventListener('keydown', onKey, true);
  backdrop.remove();
  backdrop = null;
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
}

async function open() {
  if (backdrop) { input.focus(); input.select(); return; }
  backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qo-backdrop';
  const box = document.createElement('div');
  box.className = 'qo';
  box.innerHTML = '<input class="qo-input" type="text" spellcheck="false" autocomplete="off" /><div class="qo-list"></div>';
  input = box.querySelector('.qo-input');
  input.placeholder = t('quickOpen.placeholder');
  list = box.querySelector('.qo-list');
  backdrop.appendChild(box);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  input.oninput = update;
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  input.focus();

  files = [];
  update(); // show the "loading is fast; here's nothing yet" state immediately
  try {
    const r = await window.api.listFiles();
    if (!backdrop) return; // closed while the list was loading
    files = r.ok ? r.files : [];
  } catch { files = []; }
  update();
}

// Ctrl/Cmd+P from anywhere — capture phase so a focused xterm terminal can't
// swallow it first (the same trick terminal-links.js uses for the link modifier).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    e.stopPropagation();
    open();
  }
}, true);
