// Command Palette (Ctrl/Cmd+Shift+P): a centered, keyboard-driven launcher for
// app actions — the sibling of Quick Open (Ctrl/Cmd+P), which jumps to files.
// Where Quick Open fuzzy-matches file paths, this fuzzy-matches a small registry
// of commands (renderer/shared/command-match.js) and runs the chosen one.
//
// Commands are registered once from index.js (where every action function is in
// scope) via registerCommands(). Each carries i18n keys, not resolved strings,
// so the palette re-localizes its titles every open — switching language in
// Settings is reflected the next time it opens, with no re-registration.
import { matchCommands } from './shared/command-match.js';
import { t } from '../i18n/index.js';

const MAX_ROWS = 50;

let commands = [];     // registered command descriptors (with titleKey/keywordsKey)
let backdrop = null;   // the open palette, or null when closed
let results = [];      // current filtered rows ({ command, positions })
let active = 0;        // index of the highlighted row
let input, list;

// Register the command set. Each command is
//   { id, titleKey, keywordsKey?, run }
// titleKey/keywordsKey are i18n keys resolved at open time; run() performs the
// action and may be async.
export function registerCommands(list) { commands = list; }

// Resolve the registry into the { id, title, keywords, run } shape the matcher
// and renderer want, localizing against the active locale.
function localized() {
  return commands.map((c) => ({
    id: c.id,
    title: t(c.titleKey),
    keywords: c.keywordsKey ? t(c.keywordsKey) : '',
    run: c.run,
  }));
}

// Build the title with the fuzzy-matched characters wrapped in <b>, mirroring
// quick-open's highlighting.
function highlighted(title, positions) {
  const set = new Set(positions);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < title.length; i++) {
    const ch = title[i];
    frag.appendChild(set.has(i)
      ? Object.assign(document.createElement('b'), { textContent: ch })
      : document.createTextNode(ch));
  }
  return frag;
}

function render() {
  list.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'qo-empty';
    empty.textContent = t('command.noMatches');
    list.appendChild(empty);
    return;
  }
  results.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'qo-row cmdp-row' + (i === active ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'cmdp-title';
    label.appendChild(highlighted(r.command.title, r.positions));
    row.appendChild(label);
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
  results = matchCommands(input.value, localized(), MAX_ROWS);
  active = 0;
  render();
}

function choose(i) {
  const r = results[i];
  if (!r) return;
  close();
  try { r.command.run(); } catch (err) { console.error('command failed:', r.command.id, err); }
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

export function open() {
  if (backdrop) { input.focus(); input.select(); return; }
  backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qo-backdrop';
  const box = document.createElement('div');
  box.className = 'qo';
  box.innerHTML = '<input class="qo-input" type="text" spellcheck="false" autocomplete="off" /><div class="qo-list"></div>';
  input = box.querySelector('.qo-input');
  input.placeholder = t('command.placeholder');
  list = box.querySelector('.qo-list');
  backdrop.appendChild(box);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  input.oninput = update;
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  input.focus();
  update();
}

// Ctrl/Cmd+Shift+P from anywhere — capture phase so a focused xterm terminal
// can't swallow it first (the same trick quick-open.js uses for Ctrl/Cmd+P).
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
    e.preventDefault();
    e.stopPropagation();
    open();
  }
}, true);
