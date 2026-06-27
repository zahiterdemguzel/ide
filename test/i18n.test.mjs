import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLocale, currentLocale, availableLocales, locales, BASE_LOCALE, pickLocale } from '../src/i18n/index.js';

// setLocale touches document.documentElement; the engine is otherwise DOM-free.
const doc = (globalThis.document = { documentElement: {} });

beforeEach(() => setLocale(BASE_LOCALE));

test('availableLocales: lists every registered locale with meta', () => {
  const metas = availableLocales();
  assert.deepEqual(metas.map((m) => m.code).sort(), ['de', 'en', 'es', 'fr', 'tr']);
  for (const m of metas) {
    assert.ok(m.code && m.name && m.dir, `${m.code} has code/name/dir`);
  }
});

test('t: returns the active locale string', () => {
  setLocale('tr');
  assert.equal(currentLocale(), 'tr');
  assert.equal(t('git.push'), 'Gönder');
});

test('t: falls back to English for a key the active locale omits', () => {
  // Temporarily drop a key from the tr locale to simulate an incomplete translation.
  const trStrings = locales.tr.strings;
  const saved = trStrings['git.push'];
  delete trStrings['git.push'];
  try {
    setLocale('tr');
    assert.equal(t('git.push'), 'Push'); // English fallback
  } finally {
    trStrings['git.push'] = saved;
  }
});

test('t: returns the key itself when no locale has it', () => {
  assert.equal(t('totally.unknown.key'), 'totally.unknown.key');
});

test('setLocale: an unknown code falls back to the base locale', () => {
  setLocale('zz');
  assert.equal(currentLocale(), BASE_LOCALE);
});

test('setLocale: sets document lang and dir', () => {
  setLocale('en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.documentElement.dir, 'ltr');
});

test('pickLocale: matches a system tag on its primary subtag, case-insensitively', () => {
  assert.equal(pickLocale(['tr-TR', 'en-US']), 'tr');
  assert.equal(pickLocale(['DE']), 'de');
  assert.equal(pickLocale(['fr']), 'fr');
});

test('pickLocale: honours preference order, skipping unsupported tags', () => {
  assert.equal(pickLocale(['pt-BR', 'es-ES', 'en']), 'es');
});

test('pickLocale: falls back to English when nothing matches or list is empty', () => {
  assert.equal(pickLocale(['ja', 'zh-CN']), BASE_LOCALE);
  assert.equal(pickLocale([]), BASE_LOCALE);
  assert.equal(pickLocale(), BASE_LOCALE);
});

// The regression this guards: adding a UI string to en but forgetting the other
// locales (missing key), or leaving an orphan/typo'd key in a translation (extra
// key). Missing keys are "safe" (they fall back to English) but show English text
// in a translated UI, so we require full parity.
test('locale parity: every locale has exactly the base set of keys', () => {
  const baseKeys = Object.keys(locales[BASE_LOCALE].strings).sort();
  for (const [code, loc] of Object.entries(locales)) {
    const keys = Object.keys(loc.strings).sort();
    const missing = baseKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !baseKeys.includes(k));
    assert.deepEqual(missing, [], `${code} is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${code} has orphan keys not in ${BASE_LOCALE}: ${extra.join(', ')}`);
  }
});
