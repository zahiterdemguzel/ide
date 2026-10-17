// "Go to Symbol in Workspace" (Ctrl/Cmd+T): a Quick Open-style picker over the
// language servers' workspace/symbol results. Reuses Quick Open's `.qo-*`
// look so the two pickers read as siblings. The query goes to the servers on
// each (debounced) keystroke — they do the fuzzy matching.
// The same picker backs other quick picks (language mode, indentation): a
// source with `searchEmpty` lists results before anything is typed, and items
// may carry their own `detail` text instead of a uri.

import { t } from '../../i18n/index.js';

let backdrop = null;
let input = null;
let list = null;
let results = [];
let active = 0;
let timer = null;
let run = 0;
// { search(query) → Promise<[{name, detail?, containerName, uri?, range}]>, open(item),
//   placeholder?, searchEmpty? }
let source = null;

function render() {
  list.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = input.value.trim() ? t('editor.symbolsNone') : t('editor.symbolsHint');
    list.appendChild(empty);
    return;
  }
  results.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'qo-row' + (i === active ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'qo-name';
    name.textContent = item.name;
    const where = document.createElement('span');
    where.className = 'qo-dir';
    const file = item.uri ? decodeURIComponent(item.uri.replace(/^file:\/\//, '')).split('/').pop() : '';
    where.textContent = item.detail ?? [item.containerName, file].filter(Boolean).join(' · ');
    row.append(name, where);
    row.onmousedown = (e) => { e.preventDefault(); choose(i); };
    list.appendChild(row);
  });
}

function move(dir) {
  if (!results.length) return;
  active = (active + dir + results.length) % results.length;
  render();
  const row = list.querySelector('.qo-row.active');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const item = results[i];
  if (!item) return;
  close();
  source.open(item);
}

function search() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const id = ++run;
    const query = input.value.trim();
    let found = [];
    if (query || source.searchEmpty) { try { found = await source.search(query); } catch { found = []; } }
    if (id !== run || !backdrop) return;
    results = found.slice(0, 200);
    active = 0;
    render();
  }, 150);
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
}

function close() {
  if (!backdrop) return;
  clearTimeout(timer);
  run++;
  window.removeEventListener('keydown', onKey, true);
  backdrop.remove();
  backdrop = null;
}

export function openSymbolPicker(src, initialQuery = '') {
  source = src;
  if (backdrop) { input.focus(); return; }
  backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qo-backdrop';
  const box = document.createElement('div');
  box.className = 'qo';
  box.innerHTML = '<input class="qo-input" type="text" spellcheck="false" autocomplete="off" /><div class="qo-list"></div>';
  input = box.querySelector('.qo-input');
  input.placeholder = src.placeholder || t('editor.symbolsPlaceholder');
  input.value = initialQuery;
  list = box.querySelector('.qo-list');
  backdrop.appendChild(box);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  input.oninput = search;
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  input.focus();
  input.select();
  results = [];
  render();
  if (initialQuery || src.searchEmpty) search();
}

// A quick pick over a fixed list, filtered by substring as the user types.
// items = [{ name, detail?, value }]; onPick(value) runs only on a choice.
export function quickPick(items, { placeholder, onPick }) {
  openSymbolPicker({
    placeholder,
    searchEmpty: true,
    search: async (query) => {
      const q = query.toLowerCase();
      return q ? items.filter((it) => it.name.toLowerCase().includes(q) || (it.detail || '').toLowerCase().includes(q)) : items;
    },
    open: (item) => onPick(item.value),
  });
}
