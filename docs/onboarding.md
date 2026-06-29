# First-time-user onboarding

The app greets a new user with three light-touch aids so the 5-region layout and
core workflow explain themselves without nagging anyone who already knows it: a
**guided tour** (the entry tutorial), a **keyboard cheat sheet**, and a **richer
welcome screen**. All of it is renderer-only — no main process or IPC — and every
string flows through the [i18n engine](settings.md), so it stays translated and
the parity test guards it.

## Layout

| File | Role |
|---|---|
| `src/renderer/shared/onboarding-lib.js` | Pure, tested logic: the `TOUR_STEPS` registry and `placeBubble` (callout placement math). See [testing.md](testing.md). |
| `src/renderer/onboarding/state.js` | The "tour shown" flag, fetched once (`loadOnboardingState`) and cached for sync `isTourDone()`; `setTourDone`/`resetOnboarding` persist via IPC. |
| `src/main/onboarding-store.js` + `src/preload/onboarding.js` | Main-process persistence of the flag in `onboarding.json` under the **shared** data dir. |
| `src/renderer/onboarding/tour.js` | The spotlight tour engine. |
| `src/renderer/onboarding/cheatsheet.js` | The keyboard cheat-sheet dialog + the F1/`?` listener. |
| `src/renderer/onboarding/index.js` | `initOnboarding()` (always-on help) and `activateOnboarding({ hasRepo })` (the auto tour); re-exports `startTour`/`openCheatSheet`. |
| `src/styles/onboarding.css` | Spotlight overlay, coach-mark card, cheat-sheet grid. Colors come only from theme CSS variables. |

## Activation order

`src/renderer/index.js` calls `initOnboarding()` immediately — that wires the
always-available help (the `?` button, F1/`?`, and the welcome "Take the tour"
button) and registers the `guided-tour` / `keyboard-shortcuts` command-palette
entries. The **automatic** tour is deferred: it calls `activateOnboarding()`
only via `onClaudeReady()` (from `claude-setup.js`), so a brand-new user being
walked through the Claude Code install isn't onboarded mid-install — the tour
fires only once they're past the [setup gate](architecture.md#claude-code-setup-gate).

`onClaudeReady(fn)` runs `fn` immediately if `claude` is already installed, else
when the next probe (setup-wizard Finish, or a `newSession` re-check) first finds
it — so on a fresh machine onboarding kicks in right after the install completes
(or on the next launch if a PATH refresh/restart was needed).

## Guided tour

`startTour()` builds a full-screen scrim whose **spotlight** cutout is a single
element with a huge `box-shadow` — that shadow paints the dim everywhere except
over the current step's target, which reads through clearly. A **coach-mark
card** (positioned with `placeBubble`) shows the step title, body, a `n / N`
counter, and Back / Next / Skip (Finish on the last step). `Esc`, the scrim, and
Skip all end the tour and set `tourDone`; `←`/`→` step.

`placeBubble` prefers the card above the target, flips below when there's no room,
and for a tall target where neither fits (e.g. the full-height session terminal)
falls back to a **side placement, preferring the left**, so the card always lands
on-screen beside the target.

Steps come from `TOUR_STEPS` (each `{ id, target, titleKey, bodyKey }`, `target`
a CSS selector). A step whose target is missing or hidden — e.g. a panel toggled
off in [Settings](settings.md) — is filtered out at start, so the counter and
walkthrough only cover visible regions.

**First-run trigger:** `activateOnboarding` auto-starts the tour once — gated on
`hasRepo` and `!isTourDone()` (and run only after Claude Code is installed; see
[Activation order](#activation-order)). It is always replayable from the welcome
screen's "Take the tour" button, the cheat-sheet footer ("Replay the guided
tour", which calls `resetOnboarding()` first), and the command palette.

Add a step by appending to `TOUR_STEPS` and adding its `titleKey`/`bodyKey` to
every locale.

## Keyboard cheat sheet

`openCheatSheet()` fills and `showModal()`s `#cheatsheet-dialog` from the
`SECTIONS` registry in `cheatsheet.js`. The mod key renders as `⌘` on macOS else
`Ctrl` (`navigator.platform`, matching `terminal-links.js`). It opens from the
toolbar help (`?`) button, the `F1` key (anywhere) or `?` (when not typing), and
the command palette. The listed shortcuts must stay in step with the real
handlers (`quick-open.js`, `command-palette.js`, `viewer/file.js`,
`viewer/sheet/index.js`, and `sessions.js` for the session shortcuts below); add
a row by extending `SECTIONS` and adding its `labelKey` to every locale.

`sessions.js` registers two session shortcuts in the capture phase so they win
over the focused terminal: **Shift+↓ / Shift+↑** cycle to the next/previous
**visible** session row (wrapping at both ends), and **`{MOD}`+N** opens a new
session. The cycling handler reads the list order straight off the DOM and
delegates the wrap-around math to the pure, unit-tested `shared/session-cycle.js`
(`nextSessionId`). The terminal's input is an xterm `<textarea>`, so the handler
allows the shortcuts from there (the common case) and only bails when focus is in
another editable surface (the file editor, a search box); on a hit it
`preventDefault`s so the keystroke never reaches the terminal.

## Persistence (why not localStorage)

The flag must survive restarts, but renderer `localStorage` does **not** here: the
app runs each launch in a throwaway per-instance userData profile that's deleted
on quit (see `src/main/instance.js`), so the default session's `localStorage` is
wiped every time. The flag therefore lives in `onboarding.json` in the **shared**
data dir (`src/main/onboarding-store.js`), reached over IPC — the same persistence
strategy `repo.js` uses for `last-folder.txt` / `recent-folders.json`.

`startTour()` marks the flag the moment the tour actually shows (not just on
Finish/Skip), so quitting mid-tour still counts and it never auto-runs twice.

## Resetting

`resetOnboarding()` clears the persisted flag (via `onboarding-reset` IPC) so the
tour auto-runs again — handy when testing. The cheat-sheet "Replay" button calls
it and then restarts the tour.
