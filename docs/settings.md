# Settings: theme, language & panels

The gear button at the right end of the top toolbar (`#settings-btn`) opens the
settings dialog (`#settings-dialog`), where the user picks a **theme**, a
**language**, a **notification sound**, and which **panels** are visible. Every
choice applies instantly and persists across restarts.

## Notification sound

The **Notification sound** combobox (`#settings-sound`) picks the chime that
plays when a session finishes (working → completed; see
[status-detection.md](status-detection.md#finish-notification)). The four sounds
are the `SOUNDS` registry in `src/renderer/shared/notify.js` — synthesized with
the Web Audio API, so there's no binary asset and they work offline. `settings.js`
fills the dropdown from `SOUNDS` (showing `getSound()` as selected), and on change
persists the id via `setSound()` (`localStorage` `ide.notifySound`, default
`chime`) and **previews it immediately** with `playNotification(id)`. The rest of
the app reaches the chosen sound only through `playNotification()` — nothing else
reads the setting. Add a sound by appending an entry to `SOUNDS` (id + display
name + oscillator voices); the dropdown and the test pick it up automatically.

## Where it lives

- `src/renderer/settings.js` — theme + language wiring. Reads/writes
  `localStorage` (`ide.theme`, `ide.locale`), applies the theme, sets the
  locale, builds the two dropdowns, and opens/closes the dialog. `initSettings()`
  is called once from `src/renderer/index.js` before the rest of the UI loads.
- `src/renderer/panels.js` — the panel-visibility toggles (see [Panel
  visibility](#panel-visibility)).
- `src/styles/themes.css` — theme palettes.
- `src/styles/settings.css` — the gear button + dialog styling.
- `src/i18n/` — the translation engine and locale files.

## Panel visibility

The dialog's **Panels** group is a 2-up grid of frameless switch rows, one per
toggleable area: **Explorer**, **Git**, **Terminal**, **Launch configs**,
**Tasks**, **Browser**, and **Usage metrics**.
Each row is a hidden `<input type="checkbox">` styled as a sliding toggle (the
`.switch-ui` span draws the track + knob; see `settings.css`). The sessions list
is deliberately *not* toggleable — it's the app's primary surface.

`src/renderer/panels.js` is the only wiring. It persists one JSON object to
`localStorage` (`ide.panels`, all panels default-on), exposes `isPanelEnabled(id)`
and an `onPanelsChanged(fn)` listener registry, and `applyPanels()` enforces the
current state. `initPanels()` runs once from `index.js` (after `initSettings()`),
syncing the checkboxes and applying the saved state on load.

- **Explorer / Git / Terminal** flip a panel's `.is-hidden` class
  (`display:none !important`, defined in `layout.css`, to beat the ID selectors
  that set `display:flex`). Hiding a panel also hides its drag-gutter and lets
  the surviving sibling grow: `#sidebar.no-explorer` expands the sessions list,
  `#git.solo-console` expands the terminal. The whole right aside
  (`#git`) + its column gutter hide only when **both** Git and Terminal are off;
  the console gutter shows only when **both** are on.
- **Browser** flips the top-toolbar browser button's `.is-hidden` class; a CSS
  fallback (`#browser-btn.is-hidden + #settings-btn`) hands the right-edge
  alignment to the gear so it stays pinned to the corner.
- **Usage metrics** gates the toolbar's usage meter (the 5-hour + weekly
  subscription sliders). `usage-meter.js` checks `isPanelEnabled('usage')` in its
  `render()` (staying hidden when off, regardless of available data) and
  registers `onPanelsChanged` to re-render the cached view when the toggle flips
  — no re-fetch. The meter still hides on its own when there's no usage data.
- **Launch configs / Tasks** don't hide a DOM node — they filter what the run
  toolbar renders. `toolbar.js` reads `isPanelEnabled('launch'|'tasks')` in
  `loadToolbar()` and registers `onPanelsChanged(loadToolbar)`, so toggling
  either rebuilds the toolbar (the "No .vscode/…" hint still shows only for a
  folder that genuinely has no configs).

Adding a panel toggle: append an entry to the `PANELS` array in `panels.js`, add
its checkbox (`#settings-panel-<id>`) to the dialog in `index.html`, handle its
effect in `applyPanels()`, and add the `settings.panel.<id>` string to every
locale.

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

**`--on-accent`** is the text/icon color drawn on top of an `--accent`/`--accent-hi`
fill (active tabs, primary buttons, toolbar/settings hover). It defaults to white
in `:root`, which reads well on the dark and blue accents. A theme with a *bright*
accent must override it — e.g. `high-contrast` uses a near-cyan accent, so it sets
`--on-accent: #000000` to keep the label legible instead of white-on-cyan.

### Terminals (xterm)

The session and console terminals render to a `<canvas>`, so they can't read CSS
variables on their own. Each palette therefore also defines four terminal colors
— `--term-bg`, `--term-fg`, `--term-cursor`, `--term-sel` — and
`src/renderer/shared/terminal.js` bridges them in:

- `termTheme()` reads those variables off `<html>` and returns an xterm theme
  object; every terminal is constructed with it, so new terminals match the
  active theme.
- Live terminals register with `trackTermTheme()` (and drop out with
  `untrackTermTheme()` on dispose). When the user switches theme, `settings.js`
  calls `refreshTermThemes()`, which pushes the new palette into every open
  terminal so they recolor in realtime.

When you add a theme, include the four `--term-*` variables in its block (the
console-host background uses `--term-bg` too, so the pane behind the canvas
matches).

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

**Add a translatable string:** add the key to `en.js` **and every other locale**,
then mark the element with the matching `data-i18n*` attribute. A missing key
falls back to English at runtime, but `npm test` enforces **full key parity** —
every locale must carry exactly the `en` key set (see [testing.md](testing.md)),
so adding a key to `en` alone fails CI. Dynamic strings built in JS (e.g. the
commit-count button label) are not yet routed through `t()`; do that in the
owning module when needed.

> The i18n engine is loaded as an ES module by both the browser and Node's test
> runner; `src/i18n/package.json` (`{"type":"module"}`) marks the folder ESM for
> Node. The browser ignores it and the Electron main process never imports i18n,
> so runtime is unaffected.

The default theme is dark; it's used until the user changes it.

**Language is auto-detected on first run.** When no `ide.locale` is stored yet
(a fresh install on a device), `initSettings()` seeds it from the system
language via `pickLocale(navigator.languages)` — it matches each preferred
language tag's primary subtag (e.g. `tr-TR` → `tr`) against a registered locale
in order, and falls back to English when none of ours match. The detected pick
is written to `localStorage` immediately, so a later OS-language change won't
silently switch the app; the user can always override it in the dialog.
