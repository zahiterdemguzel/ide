// User settings: theme + language. Both persist to localStorage and apply
// instantly. The dialog (gear button in the top toolbar) lets the user switch
// either; the rest of the app reads nothing here — theme flows through CSS
// custom properties and language through data-i18n attributes.
import {
  availableLocales, currentLocale, setLocale, applyTranslations, pickLocale, t,
} from '../i18n/index.js';
import { refreshTermThemes } from './shared/terminal.js';
import {
  SOUNDS, getSound, setSound, playNotification, getVolume, setVolume,
} from './shared/notify.js';
import {
  isSessionDiffBadgeEnabled, setSessionDiffBadge,
  isOsNotificationsEnabled, setOsNotificationsEnabled,
} from './sessions.js';
import { initCustomModels, refreshCustomModels } from './custom-models.js';

// Theme registry — the source of truth for the dropdown. Each id must have a
// matching [data-theme="<id>"] block in src/styles/themes.css (except "dark",
// which is the base :root palette and needs no override). Add a theme by adding
// an entry here and its CSS block.
export const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'light', name: 'Light' },
  { id: 'midnight', name: 'Midnight' },
  { id: 'solarized', name: 'Solarized' },
  { id: 'high-contrast', name: 'High Contrast' },
  { id: 'blender', name: 'Blender' },
  { id: 'dracula', name: 'Dracula' },
];

// Selectable agent models. The id is what the `claude` CLI reads from
// ANTHROPIC_MODEL (main session) / CLAUDE_CODE_SUBAGENT_MODEL (Explore/Plan/
// general-purpose/Task subagents); `default` is the sentinel that sets no env var
// (the CLI resolves the model normally, subagents inheriting the main model). The
// `name` is just shown in the dropdown — labels stay untranslated since they're
// product/model names. Edit this list to expose more models. The main process
// builds the env from the chosen id (see src/main/agent-models.js).
export const MODELS = [
  { id: 'default', name: 'Default (inherit)' },
  { id: 'fable', name: 'Fable' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];
const DEFAULT_MODEL = 'default';

const STORE = {
  theme: 'ide.theme', locale: 'ide.locale',
  model: 'ide.sessionModel', subagentModel: 'ide.subagentModel',
  statusLine: 'ide.statusLine',
};
const DEFAULT_THEME = 'dark';

// The per-session token/cost meter (Claude statusLine). Default on; stored here
// but *applied in main* at spawn time, so the value is pushed over IPC. A live
// session keeps the meter it spawned with — the toggle affects the next session.
export function isStatusLineEnabled() {
  return localStorage.getItem(STORE.statusLine) !== '0';
}
export function setStatusLineEnabled(on) {
  localStorage.setItem(STORE.statusLine, on ? '1' : '0');
  window.api?.setStatusLineEnabled?.(on);
}

// An `ollama:<name>` model id (an installed custom model). Kept as an inline
// check so the renderer doesn't reach into the main-process ollama-models-lib.
const isOllamaId = (v) => typeof v === 'string' && v.startsWith('ollama:');

// Installed Ollama custom models, cached for the dropdowns/caret menu/badge.
// Each row is { id: 'ollama:<name>', name, size, req, fit }. Refreshed from main
// on startup, on the Custom Models section, and on the `ollama-models-changed`
// push; consumers re-render off the `ollama-models-updated` window event.
let ollamaModels = [];
export function getOllamaModels() { return ollamaModels; }
export async function refreshOllamaModels() {
  try { ollamaModels = (await window.api?.ollamaList?.()) || []; }
  catch { ollamaModels = []; }
  return ollamaModels;
}
// The full list the model UIs draw from: static Claude models, then installed
// Ollama models. Ids are namespaced so they never collide.
export function getMergedModels() { return [...MODELS, ...ollamaModels]; }
// Human label for any model id (Claude alias or `ollama:<name>`).
export function modelLabel(id) {
  const claude = MODELS.find((m) => m.id === id);
  if (claude) return claude.name;
  if (isOllamaId(id)) return id.slice('ollama:'.length);
  return id;
}

// The default model a new session spawns with, read by sessions.js at creation
// (and pre-filled into the per-session picker). A stored value that's neither a
// known Claude model nor an Ollama id (e.g. a model removed from the list) falls
// back to the inherit default. An uninstalled Ollama id is left as-is here (we
// can't check installs synchronously); the session simply fails to route and the
// user re-picks — the menu self-heals when it re-renders from the live list.
function readModel(key) {
  const v = localStorage.getItem(key);
  return (MODELS.some((m) => m.id === v) || isOllamaId(v)) ? v : DEFAULT_MODEL;
}
export function getSessionModel() { return readModel(STORE.model); }
export function getSubagentModel() { return readModel(STORE.subagentModel); }

// Remember the last model chosen from the per-session picker so it sticks as the
// default for the next session. Unknown ids fall back to the inherit default.
export function setSessionModel(id) {
  const ok = MODELS.some((m) => m.id === id) || isOllamaId(id);
  localStorage.setItem(STORE.model, ok ? id : DEFAULT_MODEL);
}

function applyTheme(id) {
  const known = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = known;
  // Terminals render to a canvas and can't pick up the new CSS variables on
  // their own, so push the refreshed palette into every open terminal.
  refreshTermThemes();
}

// Advance to the next theme in the registry (wrapping), persisting and applying
// it. Exposed for the Command Palette's "Color Theme: Next" command so the user
// can flip themes without opening Settings.
export function cycleTheme() {
  const current = document.documentElement.dataset.theme || DEFAULT_THEME;
  const i = THEMES.findIndex((th) => th.id === current);
  const next = THEMES[(i + 1) % THEMES.length].id;
  localStorage.setItem(STORE.theme, next);
  applyTheme(next);
}

function fillSelect(select, items, value) {
  select.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    if (it.value === value) opt.selected = true;
    select.appendChild(opt);
  }
}

export function initSettings() {
  const savedTheme = localStorage.getItem(STORE.theme) || DEFAULT_THEME;
  // First run on this device: seed the language from the system (the browser's
  // language list), falling back to English when none of ours match. Persisting
  // the pick means a later OS-language change won't silently switch the app.
  let savedLocale = localStorage.getItem(STORE.locale);
  if (!savedLocale) {
    savedLocale = pickLocale(navigator.languages || [navigator.language]);
    localStorage.setItem(STORE.locale, savedLocale);
  }

  applyTheme(savedTheme);
  setLocale(savedLocale);
  applyTranslations();
  // Push the saved token-meter preference to main before any session spawns, so
  // the very first session honours it (main defaults on until told otherwise).
  window.api?.setStatusLineEnabled?.(isStatusLineEnabled());

  const dialog = document.getElementById('settings-dialog');
  const langSel = document.getElementById('settings-language');
  const themeSel = document.getElementById('settings-theme');
  const soundSel = document.getElementById('settings-sound');
  const volumeInput = document.getElementById('settings-volume');
  const sessionDiffBox = document.getElementById('settings-session-diff');
  const statusLineBox = document.getElementById('settings-statusline');
  const osNotifyBox = document.getElementById('settings-notifications');
  const modelSel = document.getElementById('settings-model');
  const subagentSel = document.getElementById('settings-subagent-model');

  langSel.onchange = () => {
    localStorage.setItem(STORE.locale, langSel.value);
    setLocale(langSel.value);
    applyTranslations();
  };
  themeSel.onchange = () => {
    localStorage.setItem(STORE.theme, themeSel.value);
    applyTheme(themeSel.value);
  };
  // Persist the choice and immediately preview it, so picking a sound plays it.
  // "None" persists too and previews as silence (its empty notes play nothing).
  soundSel.onchange = () => {
    setSound(soundSel.value);
    playNotification(soundSel.value);
  };
  // Same persist-then-preview pattern as the sound picker, fired on `change`
  // (handle release) rather than `input` so dragging the slider doesn't replay
  // the chime on every tick.
  volumeInput.onchange = () => {
    setVolume(Number(volumeInput.value) / 100);
    playNotification(soundSel.value);
  };
  sessionDiffBox.onchange = () => setSessionDiffBadge(sessionDiffBox.checked);
  statusLineBox.onchange = () => setStatusLineEnabled(statusLineBox.checked);
  osNotifyBox.onchange = () => setOsNotificationsEnabled(osNotifyBox.checked);
  // The model defaults apply to the *next* session created (and pre-fill the
  // per-session picker); live sessions keep the model they spawned with.
  modelSel.onchange = () => localStorage.setItem(STORE.model, modelSel.value);
  subagentSel.onchange = () => localStorage.setItem(STORE.subagentModel, subagentSel.value);

  // Fill both default-model dropdowns from the merged Claude + Ollama list. Kept
  // in one place so an Ollama install/uninstall re-renders both consistently.
  const fillModelSelects = () => {
    const opts = getMergedModels().map((m) => ({ value: m.id, label: modelLabel(m.id) }));
    fillSelect(modelSel, opts, getSessionModel());
    fillSelect(subagentSel, opts, getSubagentModel());
  };

  const open = async () => {
    fillSelect(
      langSel,
      availableLocales().map((m) => ({ value: m.code, label: m.name })),
      currentLocale(),
    );
    fillSelect(
      themeSel,
      THEMES.map((t) => ({ value: t.id, label: t.name })),
      document.documentElement.dataset.theme,
    );
    fillSelect(
      soundSel,
      SOUNDS.map((s) => ({
        value: s.id,
        label: s.id === 'none' ? t('settings.soundNone') : s.name,
      })),
      getSound(),
    );
    volumeInput.value = String(Math.round(getVolume() * 100));
    // Fill the dropdowns from the cached Ollama list right away so the dialog can
    // open instantly; the refresh below updates them if anything changed.
    fillModelSelects();
    sessionDiffBox.checked = isSessionDiffBadgeEnabled();
    statusLineBox.checked = isStatusLineEnabled();
    osNotifyBox.checked = isOsNotificationsEnabled();
    dialog.showModal();
    // Refresh installed Ollama models and the Custom Models section after the
    // dialog is up — these touch the (possibly not-yet-running) engine, so keep
    // them off the open path and re-fill the dropdowns when they resolve.
    refreshOllamaModels().then(() => { if (dialog.open) fillModelSelects(); });
    refreshCustomModels();
  };

  document.getElementById('settings-btn').onclick = open;
  document.getElementById('settings-close').onclick = () => dialog.close();
  document.getElementById('settings-done').onclick = () => dialog.close();

  // The Custom Models section (install/uninstall Ollama models) lives in its own
  // module; it calls back here to refresh the shared cache when the model set
  // changes, and re-fills the default-model dropdowns if the dialog is open.
  initCustomModels(async () => {
    await refreshOllamaModels();
    if (dialog.open) fillModelSelects();
  });

  // Keep the shared cache warm from startup so the New-session caret menu lists
  // installed models before the settings dialog is ever opened. A model
  // installed/removed anywhere (incl. from a phone-driven desktop) refreshes it.
  refreshOllamaModels().then(() => window.dispatchEvent(new CustomEvent('ollama-models-updated')));
  window.api?.onOllamaModelsChanged?.(() => {
    refreshOllamaModels().then(() => {
      if (dialog.open) fillModelSelects();
      window.dispatchEvent(new CustomEvent('ollama-models-updated'));
    });
  });
}
