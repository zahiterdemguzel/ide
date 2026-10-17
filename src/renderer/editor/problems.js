// The Problems popover, opened from the status bar's error/warning counts: every
// diagnostic the language servers (or Monaco's built-in JSON/CSS/HTML workers)
// reported, grouped by file, errors first. Clicking a row jumps to it.

import { t } from '../../i18n/index.js';

let pop = null;

function close() {
  if (!pop) return;
  pop.remove();
  pop = null;
  document.removeEventListener('mousedown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
}
function onOutside(e) { if (pop && !pop.contains(e.target)) close(); }
function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

const SEVERITY_CLASS = { 8: 'err', 4: 'warn', 2: 'info', 1: 'hint' };

// groups = [{ file, items: [{ severity (Monaco MarkerSeverity), message, source, line, column }] }]
// open(file, line, column) navigates.
export function toggleProblems(anchor, groups, open) {
  if (pop) { close(); return; }
  pop = document.createElement('div');
  pop.className = 'problems-pop';
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    const empty = document.createElement('div');
    empty.className = 'problems-empty';
    empty.textContent = t('editor.problemsNone');
    pop.appendChild(empty);
  }
  for (const group of groups) {
    if (!group.items.length) continue;
    const head = document.createElement('div');
    head.className = 'problems-file';
    head.textContent = `${group.file}  (${group.items.length})`;
    pop.appendChild(head);
    for (const item of [...group.items].sort((a, b) => b.severity - a.severity || a.line - b.line)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `problems-row ${SEVERITY_CLASS[item.severity] || 'info'}`;
      const msg = document.createElement('span');
      msg.className = 'problems-msg';
      msg.textContent = item.message;
      const where = document.createElement('span');
      where.className = 'problems-where';
      where.textContent = `${item.source ? item.source + ' · ' : ''}${item.line}:${item.column}`;
      row.append(msg, where);
      row.addEventListener('click', () => { close(); open(group.file, item.line, item.column); });
      pop.appendChild(row);
    }
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('keydown', onKey, true);
}
