import { openDialog } from './dialog.js';
import { normalizeOptions, rankOptions, initialActiveIndex, stepActiveIndex } from './option-picker.js';

// A modal text prompt. Resolves to the trimmed input, or null if the user
// cancels (Cancel button, backdrop click, or Escape). Enter confirms.
export function promptText({ title, label, placeholder = '', value = '', error = '', ok = 'Create' } = {}) {
  return openDialog({
    title,
    label,
    input: { placeholder, value, error },
    cancelValue: null,
    buttons: [
      { label: 'Cancel', value: null, variant: 'secondary' },
      // Empty input reads as "no name given", i.e. the same as cancelling.
      { label: ok, value: (text) => text || null, variant: 'primary' },
    ],
  });
}

// A searchable modal option list (launch.json `pickString` inputs). Options may
// be plain strings or { label, value }; `def` marks the default. Typing filters
// (fuzzy), ↑/↓ move the highlight, Enter picks the highlighted row (the best
// match, or the default before anything is typed), a click picks that row.
// Resolves to the picked value, or null if cancelled.
export function pickOption({ title, label, options = [], def } = {}) {
  const all = normalizeOptions(options, def);

  const search = document.createElement('input');
  search.className = 'dlg-input dlg-pick-search';
  search.type = 'text';
  search.placeholder = 'Type to filter…';
  search.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'dlg-pick-list';
  list.setAttribute('role', 'listbox');

  const hint = document.createElement('div');
  hint.className = 'dlg-pick-hint';
  hint.textContent = '↑↓ to move · Enter to select · Esc to cancel';

  let ranked = [];
  let active = -1;
  let choose = () => {};

  const paintActive = () => {
    [...list.children].forEach((row, i) => row.classList.toggle('is-active', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const render = () => {
    ranked = rankOptions(search.value, all);
    active = initialActiveIndex(ranked, search.value);
    list.replaceChildren();
    if (!ranked.length) {
      const empty = document.createElement('div');
      empty.className = 'dlg-pick-empty';
      empty.textContent = 'No matching options';
      list.append(empty);
      return;
    }
    ranked.forEach(({ option, positions }, i) => {
      const row = document.createElement('div');
      row.className = 'dlg-option';
      row.setAttribute('role', 'option');
      row.append(highlightedLabel(option.label, positions));
      if (option.isDefault) {
        const tag = document.createElement('span');
        tag.className = 'dlg-pick-default';
        tag.textContent = 'default';
        row.append(tag);
      }
      // mousedown, not click: keep focus in the search field.
      row.onmousedown = (e) => { e.preventDefault(); choose(option.value); };
      row.onmousemove = () => { if (active !== i) { active = i; paintActive(); } };
      list.append(row);
    });
    paintActive();
  };

  search.oninput = render;
  search.onkeydown = (e) => {
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 };
    if (e.key in moves) {
      e.preventDefault();
      active = Math.abs(moves[e.key]) === 1
        ? stepActiveIndex(active, moves[e.key], ranked.length)
        : Math.max(0, Math.min(ranked.length - 1, active + moves[e.key]));
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(ranked[active].option.value);
    }
  };
  render();

  return openDialog({
    title,
    label,
    content: [search, list, hint],
    cancelValue: null,
    buttons: [{ label: 'Cancel', value: null, variant: 'secondary' }],
    onOpen: ({ close }) => {
      choose = close;
      search.focus();
    },
  });
}

// The label with fuzzy-matched characters wrapped in <b>.
function highlightedLabel(text, positions) {
  const hits = new Set(positions);
  const span = document.createElement('span');
  span.className = 'dlg-pick-label';
  for (let i = 0; i < text.length; i++) {
    span.append(hits.has(i)
      ? Object.assign(document.createElement('b'), { textContent: text[i] })
      : document.createTextNode(text[i]));
  }
  return span;
}
