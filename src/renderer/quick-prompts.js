import { t } from '../i18n/index.js';
import {
  sanitizePromptMap, promptsForProject, withProjectPrompts,
} from './shared/quick-prompts.js';

// --- Quick prompts ---
// Per-project canned messages ("improve this UI", "make this model more
// realistic"), edited under Settings → Sessions and sent from the up-arrow tab at
// the bottom centre of the session view: hovering the tab unfolds the list, a click
// types the prompt into the active session and submits it. Keyed by the open
// project's root so every worktree session of a project shares one list.

const STORE_KEY = 'ide.quickPrompts';

const picker = document.getElementById('quick-prompts');
const pickerList = document.getElementById('quick-prompts-list');
const pickerHandle = document.getElementById('quick-prompts-handle');
const settingsGroup = document.getElementById('quick-prompts-settings');
const settingsList = document.getElementById('quick-prompts-rows');
const settingsProject = document.getElementById('quick-prompts-project');
const settingsProjectPrefix = document.getElementById('quick-prompts-for');
const settingsAddBtn = document.getElementById('quick-prompts-add');

let projectRoot = null;
let submitPrompt = () => false;

function readMap() {
  try { return sanitizePromptMap(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch { return {}; }
}

function writeMap(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(STORE_KEY, JSON.stringify(map));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage unavailable: the edit just doesn't persist */ }
}

const currentPrompts = () => promptsForProject(readMap(), projectRoot);

function saveCurrentPrompts(list) {
  if (!projectRoot) return;
  writeMap(withProjectPrompts(readMap(), projectRoot, list));
  renderPicker();
}

// --- Picker (bottom centre of the session view) ---

function translatedEl(tag, className, key) {
  const el = document.createElement(tag);
  el.className = className;
  el.dataset.i18n = key;
  el.textContent = t(key);
  return el;
}

function renderPicker() {
  const prompts = currentPrompts();
  pickerList.replaceChildren();
  if (!prompts.length) pickerList.append(translatedEl('div', 'qp-empty', 'quickPrompts.empty'));
  for (const text of prompts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'qp-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = text;
    item.title = text;
    item.onclick = () => sendPrompt(text);
    pickerList.append(item);
  }
  const manage = translatedEl('button', 'qp-item qp-manage', 'quickPrompts.manage');
  manage.type = 'button';
  manage.setAttribute('role', 'menuitem');
  manage.onclick = openPromptSettings;
  pickerList.append(manage);
}

// The menu opens on hover, so after a pick it would stay open under the still-
// hovering cursor; fold it until the pointer leaves so the send reads as done.
function collapseUntilPointerLeaves() {
  picker.classList.add('qp-suppressed');
  picker.addEventListener('mouseleave', () => picker.classList.remove('qp-suppressed'), { once: true });
  if (picker.contains(document.activeElement)) document.activeElement.blur();
}

function sendPrompt(text) {
  collapseUntilPointerLeaves();
  submitPrompt(text);
}

function openPromptSettings() {
  collapseUntilPointerLeaves();
  document.getElementById('settings-btn').click();
  document.querySelector('#settings-dialog .settings-nav-item[data-page="sessions"]')?.click();
  settingsGroup.scrollIntoView({ block: 'nearest' });
}

// Called by sessions' updateSessionBar: the tab belongs to a live session's
// terminal view (an archived one has no input to type into). center.js hides it
// together with the terminals when a file or other overlay takes the centre.
export function showQuickPromptsFor(session) {
  picker.hidden = !session || !!session.archived;
}

// --- Settings editor (Settings → Sessions → Quick prompts) ---

function collectSettingsPrompts() {
  return [...settingsList.querySelectorAll('.qp-row input')].map((input) => input.value);
}

function addSettingsRow(text = '', after = null) {
  const row = document.createElement('div');
  row.className = 'qp-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = text;
  input.dataset.i18nPlaceholder = 'settings.quickPromptsPlaceholder';
  input.placeholder = t('settings.quickPromptsPlaceholder');
  input.addEventListener('input', () => saveCurrentPrompts(collectSettingsPrompts()));
  // Enter opens the next row, so a list can be typed out without the mouse.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    addSettingsRow('', row).focus();
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'qp-remove';
  remove.dataset.i18nTitle = 'settings.quickPromptsRemove';
  remove.title = t('settings.quickPromptsRemove');
  remove.setAttribute('aria-label', remove.title);
  remove.textContent = '×';
  remove.onclick = () => {
    row.remove();
    saveCurrentPrompts(collectSettingsPrompts());
  };
  row.append(input, remove);
  if (after) after.after(row);
  else settingsList.append(row);
  return input;
}

// Rebuilt on every settings open and project change, which also drops rows left
// blank last time (they were never saved).
export function renderQuickPromptSettings() {
  settingsList.replaceChildren();
  settingsAddBtn.disabled = !projectRoot;
  settingsProjectPrefix.hidden = !projectRoot;
  if (projectRoot) {
    delete settingsProject.dataset.i18n;
    settingsProject.textContent = projectRoot.split(/[\\/]/).filter(Boolean).pop();
  } else {
    settingsProject.dataset.i18n = 'settings.quickPromptsNoProject';
    settingsProject.textContent = t('settings.quickPromptsNoProject');
  }
  if (!projectRoot) return;
  for (const text of currentPrompts()) addSettingsRow(text);
}

// Re-read the open project. Called on startup and on every folder change.
export async function refreshQuickPrompts() {
  try { projectRoot = await window.api.getMainRepoPath(); } catch { projectRoot = null; }
  renderPicker();
  renderQuickPromptSettings();
}

// `submit(text)` types a prompt into the active session and presses Enter; it is
// injected (rather than imported from sessions.js) because sessions.js imports
// showQuickPromptsFor from here.
export function initQuickPrompts({ submit }) {
  submitPrompt = submit;
  settingsAddBtn.onclick = () => addSettingsRow().focus();
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picker.contains(document.activeElement)) document.activeElement.blur();
  });
  pickerHandle.onclick = () => pickerList.querySelector('.qp-item')?.focus();
  refreshQuickPrompts();
}
