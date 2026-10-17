// The editor's tab strip (DOM). State transitions live in tabs-model.js; this
// renders them and turns clicks, middle-clicks, drags and the context menu into
// calls on the host's callbacks. The host owns the state and re-renders us.

import { fileIcon } from '../shared/file-icon-img.js';
import { t } from '../../i18n/index.js';

const strip = document.getElementById('editor-tabs');

let callbacks = null;
let menuEl = null;

// cb = { activate(file), pin(file), close(file), closeMany(files), move(file, index),
//        isDirty(file), reveal(file), copyPath(file) }
export function initTabs(cb) {
  callbacks = cb;
  strip.addEventListener('wheel', (e) => {
    // Vertical wheel scrolls the strip sideways, as in VS Code.
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
}

function baseName(file) { return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1); }

// Two open files with the same name get their parent folder appended, so
// "index.js · api" and "index.js · ui" can be told apart.
function labels(tabs) {
  const counts = new Map();
  for (const tab of tabs) counts.set(baseName(tab.file), (counts.get(baseName(tab.file)) || 0) + 1);
  return tabs.map((tab) => {
    const name = baseName(tab.file);
    if (counts.get(name) < 2) return { name, hint: '' };
    const parts = tab.file.split(/[\\/]/);
    return { name, hint: parts.length > 1 ? parts[parts.length - 2] : '' };
  });
}

export function renderTabs(state) {
  closeMenu();
  strip.replaceChildren();
  const names = labels(state.tabs);
  state.tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'ed-tab';
    if (tab.file === state.active) el.classList.add('active');
    if (tab.preview) el.classList.add('preview');
    if (callbacks.isDirty(tab.file)) el.classList.add('dirty');
    el.draggable = true;
    el.dataset.file = tab.file;
    el.title = tab.file;

    const icon = fileIcon(baseName(tab.file));
    icon.classList.add('ed-tab-icon');
    el.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'ed-tab-name';
    label.textContent = names[i].name;
    el.appendChild(label);
    if (names[i].hint) {
      const hint = document.createElement('span');
      hint.className = 'ed-tab-hint';
      hint.textContent = names[i].hint;
      el.appendChild(hint);
    }
    const close = document.createElement('button');
    close.className = 'ed-tab-close';
    close.title = t('editor.tabClose');
    close.setAttribute('aria-label', t('editor.tabClose'));
    close.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    close.addEventListener('click', (e) => { e.stopPropagation(); callbacks.close(tab.file); });
    el.appendChild(close);

    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); callbacks.close(tab.file); }
    });
    el.addEventListener('click', () => callbacks.activate(tab.file));
    el.addEventListener('dblclick', () => callbacks.pin(tab.file));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e, tab.file, state); });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-editor-tab', tab.file);
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-editor-tab')) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      const file = e.dataTransfer.getData('application/x-editor-tab');
      if (file && file !== tab.file) callbacks.move(file, i);
    });
    strip.appendChild(el);
  });
  strip.hidden = state.tabs.length === 0;
  const active = strip.querySelector('.ed-tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function openMenu(e, file, state) {
  closeMenu();
  const idx = state.tabs.findIndex((tab) => tab.file === file);
  const items = [
    [t('editor.tabClose'), () => callbacks.close(file)],
    [t('editor.tabCloseOthers'), () => callbacks.closeMany(state.tabs.filter((tab) => tab.file !== file).map((tab) => tab.file))],
    [t('editor.tabCloseRight'), () => callbacks.closeMany(state.tabs.slice(idx + 1).map((tab) => tab.file))],
    [t('editor.tabCloseSaved'), () => callbacks.closeMany(state.tabs.filter((tab) => !callbacks.isDirty(tab.file)).map((tab) => tab.file))],
    [t('editor.tabCloseAll'), () => callbacks.closeMany(state.tabs.map((tab) => tab.file))],
    null,
    [t('editor.tabCopyPath'), () => callbacks.copyPath(file)],
    [t('editor.tabReveal'), () => callbacks.reveal(file)],
  ];
  if (state.tabs[idx] && state.tabs[idx].preview) items.unshift([t('editor.tabKeepOpen'), () => callbacks.pin(file)]);
  menuEl = document.createElement('div');
  menuEl.className = 'ed-tab-menu';
  for (const item of items) {
    if (!item) { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'ed-tab-menu-sep' })); continue; }
    const btn = document.createElement('button');
    btn.textContent = item[0];
    btn.addEventListener('click', () => { closeMenu(); item[1](); });
    menuEl.appendChild(btn);
  }
  document.body.appendChild(menuEl);
  const { innerWidth, innerHeight } = window;
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(e.clientX, innerWidth - rect.width - 4)}px`;
  menuEl.style.top = `${Math.min(e.clientY, innerHeight - rect.height - 4)}px`;
}

function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

export function hideTabs() { strip.hidden = true; closeMenu(); }
