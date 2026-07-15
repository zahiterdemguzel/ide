# Settings: theme, language & panels

The gear button at the right end of the top toolbar (`#settings-btn`) opens the
settings dialog (`#settings-dialog`), where the user picks a **theme**, a
**language**, a **notification sound**, a few **general** on/off preferences, and
which **panels** are visible. Every choice applies instantly and persists across
restarts.

The dialog body is a **two-column grid** (`.settings-body` → two `.settings-col`,
`settings.css`), split by a vertical rule so the form reads wide rather than tall:
the left column holds language/theme/sound/volume + Agent models + General; the
right holds Panels + Remote access (the pairing QR and paired-device list). It
collapses to a single stacked column under ~560px, and the body scrolls while the
header/footer stay pinned.

## Notification sound

The **Notification sound** combobox (`#settings-sound`) picks the chime that
plays when a session finishes (working → completed; see
[status-detection.md](status-detection.md#finish-notification)). The sounds are
the `SOUNDS` registry in `src/renderer/shared/notify.js` — synthesized with the
Web Audio API, so there's no binary asset and they work offline. `settings.js`
fills the dropdown from `SOUNDS` (showing `getSound()` as selected), and on change
persists the id via `setSound()` (`localStorage` `ide.notifySound`, default
`chime`) and **previews it immediately** with `playNotification(id)`. The rest of
the app reaches the chosen sound only through `playNotification()` — nothing else
reads the setting. Add a sound by appending an entry to `SOUNDS` (id + display
name + oscillator voices); the dropdown and the test pick it up automatically.

**Muting.** The first entry, **None** (`id: 'none'`), is the mute option — there
is no separate on/off toggle. It carries empty `notes`, so selecting it (and the
finish chime that reads it) plays nothing: `playNotification('none')` is a silent
no-op. Its label is the only `SOUNDS` name that's translated (`settings.soundNone`),
since "None" is a word, not a product name; `settings.js` substitutes the
translation when filling the dropdown. For backward compatibility `getSound()`
maps the old mute flag (`localStorage` `ide.notifySoundEnabled === 'false'`, from
the former Completion-sound toggle) to `none`; `setSound()` clears that stale flag
once the user picks anything.

**Volume.** The slider below it (`#settings-volume`, 0–100 in steps of 5) scales
every note's peak gain. `getVolume()`/`setVolume()` persist it as a 0..1
multiplier (`localStorage` `ide.notifyVolume`, default `1`); the pure
`normalizeVolume()` clamps any stored or UI value into that range and is what's
unit-tested, since `localStorage` isn't available under the Node test runner (see
[testing.md](testing.md)). `settings.js` persists and previews on the slider's
`change` event (not `input`), so dragging it doesn't replay the chime on every
tick. `playNotification(id, volume)` defaults both args to the saved choices, so
the sound dropdown's own preview automatically plays at the current volume. A
volume of `0` short-circuits `playTones()` before scheduling any oscillator
(same silent path as picking "None") rather than ramping to a zero gain, which
the Web Audio API rejects for an exponential ramp target.

## Agent models

The **Agent models** group lets the user pick which model a new Claude session
runs with — both the **main** session model and the model its **subagents**
(Explore / Plan / general-purpose / Task) use. There is no env var that picks an
agent *type*; the lever Claude Code exposes is the model, via two environment
variables the spawned CLI reads:

- `ANTHROPIC_MODEL` — the main session's model.
- `CLAUDE_CODE_SUBAGENT_MODEL` — the model used for every subagent.

Two dropdowns in the settings dialog (`#settings-model`, `#settings-subagent-model`)
set the **defaults** for newly created sessions; `settings.js` owns the registry
(the `MODELS` array — the source of truth for both dropdowns and the per-session
picker) and persists each choice to `localStorage` (`ide.sessionModel`,
`ide.subagentModel`) via `getSessionModel()` / `getSubagentModel()`. The `default`
option is a sentinel meaning *don't set the env var* — the CLI then resolves the
model normally (subagents inherit the main model). A stored value no longer in
`MODELS` falls back to `default`. Add a model by appending `{ id, name }` to
`MODELS` (the `id` is the alias/model id the CLI gets; labels stay untranslated
since they're product names).

**Custom (Ollama) models.** Installed local open-source models are folded into the
same dropdowns/caret menu/badge, namespaced `ollama:<name>`, via
`getMergedModels()`/`getOllamaModels()`/`modelLabel()` in `settings.js` (re-rendered
off the `ollama-models-updated` window event). They route through a local proxy
rather than `ANTHROPIC_MODEL` alone — see [custom-models.md](custom-models.md).

**Per-session override.** The New session button is a split button: the main
action creates a session with the saved defaults, and the caret (`#new-session-opts`)
opens a dropdown (`#session-model-menu`, one entry per `MODELS` item except the
inherit `default` — the plain button already covers that — with the saved default
highlighted) — clicking a model spawns just that one session with it as the
session model (the subagent model keeps the saved default). `sessions.js`'s
`newSession(opts)` takes the override (falling back to the defaults when omitted)
and passes `{ model, subagentModel }` through the `new-session` IPC.

**Mobile.** `mobile/src/screens/SessionsScreen.tsx` mirrors the same split button:
the wide half creates with the last-picked model (its label carries the suffix —
"New session (Opus)"), the caret half opens a menu listing the concrete models.
React Native has no menu widget, so the menu is `Modal` + `Animated` reproducing
the CSS reverse-dropdown by hand (opacity/translateY/scaleY over 140ms, and the
menu is measured because RN transforms are center-origin where the CSS is
bottom-origin).
Picking one both creates the session *and* becomes the remembered default. The
list and the persistence live in `mobile/src/api/models.ts` (a copy of `MODELS`,
stored in SecureStore under the same `ide.sessionModel` key — keep it in step with
`src/renderer/settings.js`). The `model` rides on the existing `new-session` req,
which main already accepts from remote clients — no protocol change.

**Where it's applied.** Main stores the choice on the session record and turns it
into the env at spawn time: `modelEnv()` (the pure, unit-tested
`src/main/agent-models.js`) builds the `ANTHROPIC_MODEL` /
`CLAUDE_CODE_SUBAGENT_MODEL` overrides, which `sessionEnv()` merges over the
cleaned process env. The choice is persisted with the session
(`session-persist.js`), so a restored/resumed session keeps running the model it
was created with. The settings-panel defaults only affect the *next* session; a live
session is retargeted only from the session-bar model badge (below).

**Session-bar indicator.** The active session's model is shown and changeable
**live** from a pill next to the session name in `#session-bar`
(`#session-model` + its `#session-model-badge-menu` dropdown, wired in `sessions.js`;
it uses the `.effort-badge`/`.effort-menu` pill+dropdown chrome for size/look, with
the neutral default `--ec`, and the dropdown omits the `default` inherit sentinel —
only the concrete models are pickable).
Choosing a model updates the record + badge,
remembers it as the new default (`setSessionModel()`), and drives the CLI's own
**`/model <id>`** slash command by writing it to the session's PTY (`set-session-model`
IPC → `s.pty.write`), so the live session switches immediately (`default` → `/model
default`). A `/model <id>` typed
straight into the session is caught by `feedSessionCommand()` (the pure, unit-tested
`session-cmd-parse.js`, which uses the line-buffer engine `slash-parse.js`) in
`pty-input`, which pushes a **`session-model`** event the
renderer repaints from. Only the direct-argument form is detected — a bare `/model`
opens an interactive picker whose result isn't in the input stream, so it's untracked.
The badge label maps model ids to their `MODELS` names (the `default` inherit id shows
the short "Default").

**A model change can now arrive from a phone**, which is why `set-session-model` pushes
`session-model` back out at all (it used to be terminal-typed changes only): the two
clients draw the same session, and a switch made on one that left the other showing the
old model would be a badge that lies. The push carries **`typed`** — true only for a
`/model` pressed at *this* machine's keyboard — and only that origin also moves the
desktop's default for the **next new session**. A phone is choosing a model for one
session, not for this machine.

## Reasoning effort (per session)

**Effort is a session's own setting, like its model** — how hard the model thinks before
it answers. It is stored on the session record (`effort`), persisted, and applied in the
CLI's two places, which is why it needs both: `--effort <level>` as a **spawn flag**
(`effortArgs()`, the pure, unit-tested `src/main/agent-effort.js`), so a session resumed
after a restart comes back thinking as hard as it was last told to; and the **`/effort
<level>`** slash command written into a live PTY, so a running session switches at once.
Levels are the CLI's — `low`/`medium`/`high`/`xhigh`/`max`, plus `auto` (reset to the
model's own default, and the one value that adds no spawn flag).

Unlike a model alias (which `agent-models.js` forwards verbatim, the CLI resolving it),
an **unrecognized level is dropped rather than passed through**: an unknown `--effort`
value is a hard CLI error, so forwarding one would leave the session unable to spawn at
all — a session that won't start is worse than one running at the default effort.

**The control for it is on the phone**, not the desktop: `set-session-effort` +
`session-effort` mirror the model pair exactly, but the desktop's session bar has no
effort badge (there is a terminal right there — type `/effort`). A `/effort <level>`
typed into that terminal is tracked by the same `feedSessionCommand()` that tracks
`/model`, off **one** line buffer (the user is typing one line; a second parser fed the
same keystrokes would have to repeat the same backspace/kill bookkeeping to stay in step
with it), so the phone's badge follows a change made at the machine. See
[remote-access.md](remote-access.md) — "The session as a chat".

## General preferences

The **General** group (same frameless switch rows as Panels) holds standalone
on/off toggles wired in `src/renderer/settings.js`:

- **Diff stats on sessions** (`#settings-session-diff`, default **off**) shows a
  per-row `+added -removed` badge in the sessions list (the same numbers as the
  session bar's Diff button). `sessions.js` owns the flag (`localStorage`
  `ide.sessionDiffBadge`) via `isSessionDiffBadgeEnabled()` /
  `setSessionDiffBadge()`; `renderRowDiff(s)` paints each row's `.sess-diff` badge
  from the session's `diffStat` whenever the stat refreshes, and flipping the
  toggle re-renders every row.
- **Token cost meter** (`#settings-statusline`, default **on**) gates the
  per-session token/cost status line at the bottom of each session's terminal
  (see [architecture.md](architecture.md#per-session-token-meter)). Unlike the
  other two — whose effect is renderer-side — this one is *applied in main* at
  spawn time, so `settings.js` both persists the flag (`localStorage`
  `ide.statusLine`, `isStatusLineEnabled()` / `setStatusLineEnabled()`) **and
  pushes it to main over IPC** (`set-statusline-enabled` → `statusline.setEnabled`).
  It's pushed on startup (before any session spawns) and on every change; main
  defaults on until told otherwise, and `statusLineCommand()` returns null when
  off so the next-spawned session gets no statusLine. A **live session keeps the
  meter it spawned with** — the toggle affects the next session, like the agent
  model defaults.
- **Desktop notifications** (`#settings-notifications`, default **off**) sends an
  OS-level notification on the same working → completed transition that triggers
  the chime (see [Finish notification](status-detection.md#finish-notification)).
  Off by default since, unlike the chime, it can pull focus away from whatever the
  user is doing. `sessions.js` owns the flag (`localStorage` `ide.osNotifications`)
  via `isOsNotificationsEnabled()` / `setOsNotificationsEnabled()`, checked inside
  `celebrateFinish()`. When on, it sends the already-translated title/body to main
  over the `notify-session-finished` IPC channel (main never loads i18n, so the
  renderer composes the strings); `src/main/window.js` builds an Electron
  `Notification` and shows it — unless the app window is already focused, in
  which case it's skipped (`win.isFocused()`), since there's no point pulling
  attention to a window the user is already looking at. Clicking it raises and
  focuses the window (restoring it first if minimized) and pushes
  `select-session` back to the renderer, which calls `selectSession(id)` to
  open the session the notification was about.

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
so adding a key to `en` alone fails `npm test`. Dynamic strings built in JS (e.g. the
commit-count button label) are not yet routed through `t()`; do that in the
owning module when needed. The [first-time onboarding](onboarding.md) (guided
tour, cheat sheet, hints) follows these same i18n and `localStorage` patterns.

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
