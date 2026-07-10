console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval ../i18n/index.js'); // PERF-TEMP
// Tiny dependency-free i18n engine.
//
// To add a language: create src/i18n/locales/<code>.js exporting
// { meta: { code, name, dir }, strings: { ... } }, then add it to the LOCALES
// list below. The settings dropdown is built from this list, so that is the
// only wiring needed. English (en) is the base — any key a locale omits falls
// back to English, so a partial translation is safe to ship.
import en from './locales/en.js';
import tr from './locales/tr.js';
import es from './locales/es.js';
import de from './locales/de.js';
import fr from './locales/fr.js';

const LOCALES = [en, tr, es, de, fr];

export const BASE_LOCALE = 'en';
export const locales = Object.fromEntries(LOCALES.map((l) => [l.meta.code, l]));

let current = BASE_LOCALE;

export function availableLocales() {
  return LOCALES.map((l) => l.meta);
}

export function currentLocale() {
  return current;
}

export function setLocale(code) {
  current = locales[code] ? code : BASE_LOCALE;
  const { dir } = locales[current].meta;
  document.documentElement.lang = current;
  document.documentElement.dir = dir || 'ltr';
}

// Pick the best-matching registered locale for an ordered list of preferred
// language tags (e.g. navigator.languages: ['tr-TR', 'en-US']). Each tag's
// primary subtag is matched case-insensitively against a locale code; the
// first hit wins. Falls back to English when nothing matches, so an
// unsupported system language lands on en. Used to seed the locale on first run.
export function pickLocale(preferred = []) {
  for (const tag of preferred) {
    const primary = String(tag).toLowerCase().split('-')[0];
    if (locales[primary]) return primary;
  }
  return BASE_LOCALE;
}

// Look up a key in the active locale, falling back to English, then the key
// itself so a missing string is visible rather than blank.
export function t(key) {
  const active = locales[current]?.strings;
  if (active && key in active) return active[key];
  if (key in locales[BASE_LOCALE].strings) return locales[BASE_LOCALE].strings[key];
  return key;
}

// Re-render every translatable node under `root`. Elements opt in with:
//   data-i18n            -> textContent
//   data-i18n-html       -> innerHTML (use only for trusted markup in locales)
//   data-i18n-placeholder-> placeholder attribute
//   data-i18n-title      -> title attribute
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
