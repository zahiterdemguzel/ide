// The editor's status bar, a slim strip under the code like VS Code's:
//   left  — problems (errors / warnings) for the open files → problems popover
//   right — Ln/Col (+ selection), indentation, line endings, encoding, language,
//           language-server state, AI completions toggle.
// Each item is a button that hands its click to the host (go to line, pick a
// language, restart the server…). The host calls update() whenever any of it
// may have changed.

import { t } from '../../i18n/index.js';

const bar = document.getElementById('editor-status');

const items = {};
let callbacks = null;

function item(id, side, titleKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'es-item';
  btn.dataset.item = id;
  if (titleKey) btn.dataset.titleKey = titleKey;
  btn.addEventListener('click', (e) => callbacks[id] && callbacks[id](e, btn));
  side.appendChild(btn);
  items[id] = btn;
  return btn;
}

// cb = { problems, position, indent, eol, language, lsp, ai } click handlers.
export function initStatusBar(cb) {
  callbacks = cb;
  const left = document.createElement('div');
  left.className = 'es-side';
  const right = document.createElement('div');
  right.className = 'es-side';
  bar.append(left, right);
  item('problems', left, 'editor.statusProblems');
  item('conflict', left);
  item('position', right, 'editor.statusGoToLine');
  item('indent', right, 'editor.statusIndent');
  item('eol', right, 'editor.statusEol');
  item('encoding', right);
  item('language', right, 'editor.statusLanguage');
  item('lsp', right, 'editor.statusLsp');
  item('ai', right, 'editor.statusAi');
  items.encoding.textContent = 'UTF-8';
  items.encoding.disabled = true;
}

const ICON_ERROR = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>';
const ICON_WARN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>';
const ICON_SPARK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg>';

// s = { line, column, selected, selections, tabSize, insertSpaces, eol, languageLabel,
//       errors, warnings, lsp: {state, name, message}|null, ai: {enabled, available, busy},
//       conflict: bool, readOnly: bool }
export function updateStatusBar(s) {
  items.problems.innerHTML = `${ICON_ERROR}<span>${s.errors}</span>${ICON_WARN}<span>${s.warnings}</span>`;
  items.problems.classList.toggle('has-errors', s.errors > 0);

  items.conflict.hidden = !s.conflict;
  items.conflict.textContent = t('editor.conflictStatus');

  let pos = t('editor.statusPos').replace('{line}', s.line).replace('{col}', s.column);
  if (s.selections > 1) pos += ` ${t('editor.statusSelections').replace('{n}', s.selections)}`;
  else if (s.selected) pos += ` ${t('editor.statusSelected').replace('{n}', s.selected)}`;
  items.position.textContent = pos;

  items.indent.textContent = (s.insertSpaces ? t('editor.statusSpaces') : t('editor.statusTabSize')).replace('{n}', s.tabSize);
  items.eol.textContent = s.eol;
  items.language.textContent = s.readOnly ? `${s.languageLabel} · ${t('editor.readOnly')}` : s.languageLabel;

  const lsp = s.lsp;
  items.lsp.hidden = !lsp;
  if (lsp) {
    items.lsp.className = `es-item lsp-${lsp.state}`;
    items.lsp.textContent = `{ } ${lsp.name || ''}`.trim();
    items.lsp.title = `${t('editor.statusLsp')}: ${lsp.state}${lsp.message ? ` — ${lsp.message}` : ''}`;
  }

  items.ai.innerHTML = `${ICON_SPARK}<span>${t('editor.statusAiLabel')}</span>`;
  items.ai.classList.toggle('off', !s.ai.enabled);
  items.ai.classList.toggle('unavailable', s.ai.enabled && !s.ai.available);
  items.ai.classList.toggle('busy', !!s.ai.busy);

  for (const btn of Object.values(items)) {
    if (btn.dataset.titleKey && btn !== items.lsp) btn.title = t(btn.dataset.titleKey);
  }
  if (s.ai.enabled && !s.ai.available) items.ai.title = t('editor.statusAiUnavailable');
}

export function showStatusBar(show) { bar.hidden = !show; }
