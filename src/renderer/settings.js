// User settings: theme + language. Both persist to localStorage and apply
// instantly. The dialog (gear button in the top toolbar) lets the user switch
// either; the rest of the app reads nothing here — theme flows through CSS
// custom properties and language through data-i18n attributes.
import {
  availableLocales, currentLocale, setLocale, applyTranslations, pickLocale,
} from '../i18n/index.js';
import { refreshTermThemes } from './shared/terminal.js';
import { SOUNDS, getSound, setSound, playNotification } from './shared/notify.js';

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
];

const STORE = { theme: 'ide.theme', locale: 'ide.locale' };
const DEFAULT_THEME = 'dark';

function applyTheme(id) {
  const known = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = known;
  // Terminals render to a canvas and can't pick up the new CSS variables on
  // their own, so push the refreshed palette into every open terminal.
  refreshTermThemes();
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

  const dialog = document.getElementById('settings-dialog');
  const langSel = document.getElementById('settings-language');
  const themeSel = document.getElementById('settings-theme');
  const soundSel = document.getElementById('settings-sound');

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
  soundSel.onchange = () => {
    setSound(soundSel.value);
    playNotification(soundSel.value);
  };

  const open = () => {
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
      SOUNDS.map((s) => ({ value: s.id, label: s.name })),
      getSound(),
    );
    dialog.showModal();
  };

  document.getElementById('settings-btn').onclick = open;
  document.getElementById('settings-close').onclick = () => dialog.close();
  document.getElementById('settings-done').onclick = () => dialog.close();
}
