# Settings: theme & language

The gear button at the right end of the top toolbar (`#settings-btn`) opens the
settings dialog (`#settings-dialog`), where the user picks a **theme** and a
**language**. Both choices apply instantly and persist across restarts.

## Where it lives

- `src/renderer/settings.js` — the only wiring. Reads/writes `localStorage`
  (`ide.theme`, `ide.locale`), applies the theme, sets the locale, builds the
  two dropdowns, and opens/closes the dialog. `initSettings()` is called once
  from `src/renderer/index.js` before the rest of the UI loads.
- `src/styles/themes.css` — theme palettes.
- `src/styles/settings.css` — the gear button + dialog styling.
- `src/i18n/` — the translation engine and locale files.

Nothing else in the app reads settings directly: **theme** flows entirely
through CSS custom properties, and **language** through `data-i18n*` attributes.

## Theming

Every color is a CSS custom property defined on `:root` in `base.css` (the
default "dark" palette). A theme is a block in `themes.css` that overrides those
properties, scoped to `html[data-theme="<id>"]`. `settings.js` sets
`document.documentElement.dataset.theme`.

**Add a theme:**
1. Add a `[data-theme="<id>"] { … }` block in `src/styles/themes.css` with the
   full variable set.
2. Add `{ id: '<id>', name: '<Display Name>' }` to the `THEMES` array in
   `src/renderer/settings.js` (this array drives the dropdown).

`dark` is the base `:root` palette and needs no `themes.css` block.

## Internationalization (i18n)

`src/i18n/index.js` is a tiny dependency-free engine:

- Locales are registered in the `LOCALES` list. Each is
  `src/i18n/locales/<code>.js` exporting `{ meta: { code, name, dir }, strings }`.
- `t(key)` looks up the active locale, falling back to English (`BASE_LOCALE`),
  then the key itself — so a partial translation is safe to ship.
- `applyTranslations(root)` re-renders every translatable node. Elements opt in
  with attributes:
  - `data-i18n` → `textContent`
  - `data-i18n-html` → `innerHTML` (only for trusted markup that lives in the
    locale files, e.g. the empty-session hint)
  - `data-i18n-placeholder` → `placeholder`
  - `data-i18n-title` → `title`

  Buttons that mix an icon with text wrap the text in a `<span data-i18n="…">`
  so the SVG/`<img>` is preserved.

**Add a language:**
1. Create `src/i18n/locales/<code>.js` (copy `en.js`, translate the values).
2. Add it to the `LOCALES` import list in `src/i18n/index.js`. The dropdown is
   built from that list, so no other wiring is needed.

**Add a translatable string:** add the key to `en.js` (and ideally the other
locales), then mark the element with the matching `data-i18n*` attribute.
Dynamic strings built in JS (e.g. the commit-count button label) are not yet
routed through `t()`; do that in the owning module when needed.

The default language is English and the default theme is dark; both are used
until the user changes them.
