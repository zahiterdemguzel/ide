// User settings: theme + language. Both persist to localStorage and apply
// instantly. The dialog (gear button in the top toolbar) lets the user switch
// either; the rest of the app reads nothing here — theme flows through CSS
// custom properties and language through data-i18n attributes.
import {
  availableLocales, currentLocale, setLocale, applyTranslations, pickLocale, t,
} from '../i18n/index.js';
import { refreshTermThemes } from './shared/terminal.js';
import { EFFORTS, DEFAULT_EFFORT, effortsForFamily, effortNameForFamily } from './shared/effort-levels.js';
// The badge reads the ladder through here (the model/effort facade), not around it.
export { DEFAULT_EFFORT } from './shared/effort-levels.js';
import {
  SOUNDS, getSound, setSound, playNotification, getVolume, setVolume,
} from './shared/notify.js';
import {
  isSessionDiffBadgeEnabled, setSessionDiffBadge, isQuickEffortButtonsEnabled, setQuickEffortButtons,
  isOsNotificationsEnabled, setOsNotificationsEnabled,
} from './sessions.js';
import { initCustomModels, refreshCustomModels } from './custom-models.js';
import { initVoice, refreshVoiceSection } from './voice.js';
import { initEditorSettingsSection, refreshEditorSettingsSection } from './editor/settings-section.js';
import { initSettingsNav } from './settings-nav.js';

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
// The OpenAI Codex CLI's models. A `codex:` id spawns the `codex` binary instead
// of `claude` (see src/main/agent-providers.js), and the session is locked to
// the codex family for life — the model menus only offer same-family switches.
export const CODEX_MODELS = [
  { id: 'codex:gpt-5.5', name: 'GPT-5.5 (Codex)' },
  { id: 'codex:gpt-5.4', name: 'GPT-5.4 (Codex)' },
  { id: 'codex:gpt-5.4-mini', name: 'GPT-5.4 Mini (Codex)' },
];
const DEFAULT_MODEL = 'default';

const STORE = {
  theme: 'ide.theme', locale: 'ide.locale',
  model: 'ide.sessionModel', subagentModel: 'ide.subagentModel',
  effort: 'ide.sessionEffort', menuFamily: 'ide.newSessionMenuFamily',
  // Suffixed with a model family (`ide.lastModel.codex`) — see getLastModelOf.
  lastModelPrefix: 'ide.lastModel.',
  statusLine: 'ide.statusLine',
  toolHooks: 'ide.toolHooks',
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

// Whether spawned sessions hook every tool call (default) or only the few tools
// that drive status, asks and edit tracking — the light mode for sessions that
// run many subagents. Applied in main at spawn time, like the token meter.
export function isToolHooksEnabled() {
  return localStorage.getItem(STORE.toolHooks) !== '0';
}
export function setToolHooksEnabled(on) {
  localStorage.setItem(STORE.toolHooks, on ? '1' : '0');
  window.api?.setToolHooksEnabled?.(on);
}

// An `ollama:<name>` model id (an installed custom model). Kept as an inline
// check so the renderer doesn't reach into the main-process ollama-models-lib.
const isOllamaId = (v) => typeof v === 'string' && v.startsWith('ollama:');
const isCodexId = (v) => typeof v === 'string' && v.startsWith('codex:');

// Which CLI family a model id runs on — the renderer mirror of the main
// process's agent-providers.modelFamily. A session may only switch models
// within its family (and never off a local model), so every model menu filters
// its rows through switchableModels().
export function modelFamily(id) {
  if (isCodexId(id)) return 'codex';
  if (isOllamaId(id)) return 'ollama';
  return 'claude';
}
export function switchableModels(currentId) {
  const family = modelFamily(currentId);
  if (family === 'ollama') return []; // a local model is fixed for life
  return getMergedModels().filter((m) => modelFamily(m.id) === family);
}

// The effort ladder a session may pick from — its model's family owns it, so a Codex
// session offers Codex's stops and everything else offers the CLI's. Main enforces the
// same split (set-session-effort), so a stale menu can't sneak a level through.
export function effortsFor(modelId) {
  return effortsForFamily(modelFamily(modelId));
}
export function effortName(id, modelId) {
  return effortNameForFamily(id, modelFamily(modelId));
}

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
// The full list the model UIs draw from: static Claude models, Codex models,
// then installed Ollama models. Ids are namespaced so they never collide.
export function getMergedModels() { return [...MODELS, ...CODEX_MODELS, ...ollamaModels]; }
// Human label for any model id (Claude alias, `codex:<model>` or `ollama:<name>`).
export function modelLabel(id) {
  const known = MODELS.find((m) => m.id === id) || CODEX_MODELS.find((m) => m.id === id);
  if (known) return known.name;
  if (isCodexId(id)) return id.slice('codex:'.length);
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
  return (MODELS.some((m) => m.id === v) || CODEX_MODELS.some((m) => m.id === v) || isOllamaId(v)) ? v : DEFAULT_MODEL;
}
export function getSessionModel() { return readModel(STORE.model); }
export function getSubagentModel() { return readModel(STORE.subagentModel); }

// Remember the last model chosen from the per-session picker so it sticks as the
// default for the next session. Unknown ids fall back to the inherit default.
export function setSessionModel(id) {
  const ok = MODELS.some((m) => m.id === id) || CODEX_MODELS.some((m) => m.id === id) || isOllamaId(id);
  localStorage.setItem(STORE.model, ok ? id : DEFAULT_MODEL);
  if (ok) localStorage.setItem(STORE.lastModelPrefix + modelFamily(id), id);
}

// The most recently used model of one family, remembered apart from the session model
// (which may belong to another family). The New-session caret's effort rows spawn with
// it. Falls back to the session model when it's in that family, then to the family's
// first concrete model (Claude's is the inherit default).
export function getLastModelOf(family) {
  const inFamily = (v) => modelFamily(v) === family && getMergedModels().some((m) => m.id === v);
  const stored = localStorage.getItem(STORE.lastModelPrefix + family);
  if (inFamily(stored)) return stored;
  const current = getSessionModel();
  if (inFamily(current)) return current;
  return getMergedModels().find((m) => modelFamily(m.id) === family)?.id || DEFAULT_MODEL;
}

// Which model family the New-session caret menu lists: Claude by default, but someone
// who mostly runs Codex or local models can switch it in Settings → Agent models.
export const NEW_SESSION_MENU_FAMILIES = ['claude', 'codex', 'ollama'];
export function getNewSessionMenuFamily() {
  const v = localStorage.getItem(STORE.menuFamily);
  return NEW_SESSION_MENU_FAMILIES.includes(v) ? v : 'claude';
}
function setNewSessionMenuFamily(family) {
  if (NEW_SESSION_MENU_FAMILIES.includes(family)) localStorage.setItem(STORE.menuFamily, family);
}

// The last effort chosen from the per-session badge, reused as the starting level for
// the next session. Stored without a family: the ladders overlap, and main clamps what
// doesn't fit (a remembered `max` landing on a Codex session) at creation, so the raw
// last pick is the honest thing to keep here.
export function getSessionEffort() {
  const v = localStorage.getItem(STORE.effort);
  return EFFORTS.some((e) => e.id === v) ? v : DEFAULT_EFFORT;
}

export function setSessionEffort(id) {
  if (EFFORTS.some((e) => e.id === id)) localStorage.setItem(STORE.effort, id);
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

// One card per theme, each drawing a miniature window in that theme's own palette
// (the preview carries data-theme, so themes.css scopes the variables to it).
function renderThemeCards(grid, activeId, onPick) {
  const cards = THEMES.map((theme) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(theme.id === activeId));
    card.tabIndex = theme.id === activeId ? 0 : -1;
    card.dataset.themeId = theme.id;
    const preview = document.createElement('span');
    preview.className = 'theme-preview';
    preview.dataset.theme = theme.id;
    preview.innerHTML =
      '<span class="theme-preview-side"><i></i><i></i><i></i></span>' +
      '<span class="theme-preview-main"><i class="accent"></i><i></i><i class="short"></i><i class="green"></i></span>';
    const name = document.createElement('span');
    name.className = 'theme-card-name';
    name.textContent = theme.name;
    card.append(preview, name);
    card.onclick = () => onPick(theme.id);
    return card;
  });
  grid.replaceChildren(...cards);
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
  window.api?.setToolHooksEnabled?.(isToolHooksEnabled());

  const dialog = document.getElementById('settings-dialog');
  const langSel = document.getElementById('settings-language');
  const themeGrid = document.getElementById('settings-theme-grid');
  const soundSel = document.getElementById('settings-sound');
  const volumeInput = document.getElementById('settings-volume');
  const volumeValue = document.getElementById('settings-volume-value');
  const sessionDiffBox = document.getElementById('settings-session-diff');
  const statusLineBox = document.getElementById('settings-statusline');
  const toolHooksBox = document.getElementById('settings-tool-hooks');
  const quickEffortBox = document.getElementById('settings-quick-effort');
  const osNotifyBox = document.getElementById('settings-notifications');
  const modelSel = document.getElementById('settings-model');
  const subagentSel = document.getElementById('settings-subagent-model');
  const menuFamilySel = document.getElementById('settings-new-session-menu');

  langSel.onchange = () => {
    localStorage.setItem(STORE.locale, langSel.value);
    setLocale(langSel.value);
    applyTranslations();
  };
  const pickTheme = (id) => {
    localStorage.setItem(STORE.theme, id);
    applyTheme(id);
    for (const card of themeGrid.children) {
      const selected = card.dataset.themeId === id;
      card.setAttribute('aria-checked', String(selected));
      card.tabIndex = selected ? 0 : -1;
    }
  };
  // Arrow keys move the selection like a native radio group.
  themeGrid.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const cards = [...themeGrid.children];
    const current = cards.findIndex((card) => card.getAttribute('aria-checked') === 'true');
    const next = cards[(current + step + cards.length) % cards.length];
    pickTheme(next.dataset.themeId);
    next.focus();
  });
  // Persist the choice and immediately preview it, so picking a sound plays it.
  // "None" persists too and previews as silence (its empty notes play nothing).
  soundSel.onchange = () => {
    setSound(soundSel.value);
    playNotification(soundSel.value);
  };
  // Same persist-then-preview pattern as the sound picker, fired on `change`
  // (handle release) rather than `input` so dragging the slider doesn't replay
  // the chime on every tick.
  const showVolume = () => { volumeValue.textContent = `${volumeInput.value}%`; };
  volumeInput.oninput = showVolume;
  volumeInput.onchange = () => {
    setVolume(Number(volumeInput.value) / 100);
    playNotification(soundSel.value);
  };
  sessionDiffBox.onchange = () => setSessionDiffBadge(sessionDiffBox.checked);
  statusLineBox.onchange = () => setStatusLineEnabled(statusLineBox.checked);
  toolHooksBox.onchange = () => setToolHooksEnabled(toolHooksBox.checked);
  quickEffortBox.onchange = () => setQuickEffortButtons(quickEffortBox.checked);
  osNotifyBox.onchange = () => setOsNotificationsEnabled(osNotifyBox.checked);
  // The model defaults apply to the *next* session created (and pre-fill the
  // per-session picker); live sessions keep the model they spawned with.
  modelSel.onchange = () => setSessionModel(modelSel.value);
  menuFamilySel.onchange = () => setNewSessionMenuFamily(menuFamilySel.value);
  subagentSel.onchange = () => localStorage.setItem(STORE.subagentModel, subagentSel.value);

  // Fill both default-model dropdowns from the merged Claude + Codex + Ollama
  // list. Kept in one place so an Ollama install/uninstall re-renders both
  // consistently. The subagent dropdown skips codex: models — Codex has no
  // subagent-model override, so offering one there would be a lie.
  const fillModelSelects = () => {
    const opts = getMergedModels().map((m) => ({ value: m.id, label: modelLabel(m.id) }));
    fillSelect(modelSel, opts, getSessionModel());
    fillSelect(subagentSel, opts.filter((o) => modelFamily(o.value) !== 'codex'), getSubagentModel());
  };

  const open = async () => {
    fillSelect(
      langSel,
      availableLocales().map((m) => ({ value: m.code, label: m.name })),
      currentLocale(),
    );
    renderThemeCards(themeGrid, document.documentElement.dataset.theme, pickTheme);
    fillSelect(
      soundSel,
      SOUNDS.map((s) => ({
        value: s.id,
        label: s.id === 'none' ? t('settings.soundNone') : s.name,
      })),
      getSound(),
    );
    volumeInput.value = String(Math.round(getVolume() * 100));
    showVolume();
    // Fill the dropdowns from the cached Ollama list right away so the dialog can
    // open instantly; the refresh below updates them if anything changed.
    fillModelSelects();
    fillSelect(
      menuFamilySel,
      NEW_SESSION_MENU_FAMILIES.map((f) => ({ value: f, label: t(`settings.menuFamily.${f}`) })),
      getNewSessionMenuFamily(),
    );
    sessionDiffBox.checked = isSessionDiffBadgeEnabled();
    statusLineBox.checked = isStatusLineEnabled();
    toolHooksBox.checked = isToolHooksEnabled();
    quickEffortBox.checked = isQuickEffortButtonsEnabled();
    osNotifyBox.checked = isOsNotificationsEnabled();
    refreshEditorSettingsSection();
    resetSettingsNav();
    dialog.showModal();
    // Refresh installed Ollama models and the Custom Models section after the
    // dialog is up — these touch the (possibly not-yet-running) engine, so keep
    // them off the open path and re-fill the dropdowns when they resolve.
    refreshOllamaModels().then(() => { if (dialog.open) fillModelSelects(); });
    refreshCustomModels();
    // Same reason: it asks main what voice weights are actually on disk.
    refreshVoiceSection();
  };

  document.getElementById('settings-btn').onclick = open;
  document.getElementById('settings-close').onclick = () => dialog.close();
  // Clicking the dimmed backdrop (outside the dialog box) closes it too.
  dialog.addEventListener('mousedown', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // The Custom Models section (install/uninstall Ollama models) lives in its own
  // module; it calls back here to refresh the shared cache when the model set
  // changes, and re-fills the default-model dropdowns if the dialog is open.
  // Voice input (dictate-on-hover) owns its own settings row, IPC and mic capture;
  // it only needs to be started once, from here, like the Custom Models section.
  initVoice();
  initEditorSettingsSection();
  const resetSettingsNav = initSettingsNav();

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
