// Quick Open palette (Ctrl/Cmd+P): a centered, keyboard-driven fuzzy file
// switcher — the IDE staple for jumping to a file without touching the tree. It
// fetches the repo's flat file list once per open (list-files) and fuzzy-matches
// client-side as you type (renderer/shared/fuzzy.js), so every keystroke is
// instant with no IPC. Like the explorer's search, it also greps file contents
// (search-refs) in the background and streams the hits in under a "References"
// heading, so Ctrl+P finds the same things the sidebar search does. Enter opens
// the highlighted row through the same openFromTree() the tree and search use
// (references jump to their line); ↑/↓ move, Esc/backdrop dismiss.
import { fuzzyFilter } from './shared/fuzzy.js';
import { fileColor } from './shared/ext.js';
import { openFromTree } from './viewer/center.js';
import { t } from '../i18n/index.js';

const MAX_ROWS = 100;
const REFS_DEBOUNCE_MS = 200;

let backdrop = null;   // the open palette, or null when closed
let files = [];        // the repo's flat file list for this open
let results = [];      // current filtered + ranked rows ({ item, positions })
let refs = [];         // content matches for the current query ({ file, line, text })
let refsPending = false;
let refsTimer = null;
let refsRun = 0;       // guards a slow grep landing after the query changed
let active = 0;        // index of the highlighted row (files first, then refs)
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

function heading(label) {
  const h = document.createElement('div');
  h.className = 'qo-heading';
  h.textContent = label;
  return h;
}

function refRow(m, i) {
  const row = document.createElement('div');
  row.className = 'qo-row qo-ref' + (i === active ? ' active' : '');
  row.title = `${m.file}:${m.line}`;
  const name = document.createElement('span');
  name.className = 'qo-name';
  name.style.color = fileColor(m.file);
  name.textContent = `${m.file}:${m.line}`;
  const snip = document.createElement('span');
  snip.className = 'qo-snippet';
  snip.textContent = m.text.trim();
  row.append(name, snip);
  row.onmousemove = () => setActive(i);
  row.onclick = () => choose(i);
  return row;
}

function render() {
  list.replaceChildren();
  const q = input.value.trim();
  if (!results.length && !q) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = files.length ? t('quickOpen.noMatches') : t('quickOpen.empty');
    list.appendChild(empty);
    return;
  }
  if (q) list.appendChild(heading(`${t('quickOpen.files')} (${results.length})`));
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'qo-row' + (i === active ? ' active' : '');
    row.title = r.item;
    row.appendChild(highlighted(r.item, r.positions));
    row.onmousemove = () => setActive(i);
    row.onclick = () => choose(i);
    list.appendChild(row);
  });
  if (!q) return;
  list.appendChild(heading(refsPending
    ? `${t('quickOpen.references')}…`
    : `${t('quickOpen.references')} (${refs.length})`));
  refs.forEach((m, k) => list.appendChild(refRow(m, results.length + k)));
}

function setActive(i) {
  if (i === active) return;
  active = i;
  const rows = list.querySelectorAll('.qo-row');
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === active);
  rows[active]?.scrollIntoView({ block: 'nearest' });
}

function rowCount() { return results.length + refs.length; }

function move(delta) {
  const n = rowCount();
  if (!n) return;
  setActive((active + delta + n) % n);
}

// Content search is a subprocess grep per query, so unlike the client-side fuzzy
// match it's debounced; the run token drops a slow response for a stale query.
function scheduleRefs(q) {
  clearTimeout(refsTimer);
  const run = ++refsRun;
  refs = [];
  refsPending = !!q;
  if (!q) return;
  refsTimer = setTimeout(async () => {
    let matches = [];
    try {
      const r = await window.api.searchRefs(q);
      matches = r.ok ? r.matches : [];
    } catch { /* keep empty */ }
    if (!backdrop || run !== refsRun) return;
    refs = matches;
    refsPending = false;
    render();
  }, REFS_DEBOUNCE_MS);
}

function update() {
  const q = input.value.trim();
  results = fuzzyFilter(q, files, MAX_ROWS);
  scheduleRefs(q);
  active = 0;
  render();
}

function choose(i) {
  const q = input.value.trim();
  if (i < results.length) {
    const r = results[i];
    if (!r) return;
    close();
    openFromTree(r.item);
    return;
  }
  const m = refs[i - results.length];
  if (!m) return;
  close();
  openFromTree(m.file, { line: m.line, term: q });
}

function close() {
  if (!backdrop) return;
  clearTimeout(refsTimer);
  refsRun++;
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

export async function open() {
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
