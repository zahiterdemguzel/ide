# Project memory

Index of what's worth remembering about this project. Each line links to a detail file — these are **read on demand, never all upfront**. Open only the one file whose area your task touches, and read only the section you need (they cross-link, so follow a link when one points you elsewhere). Don't pre-read them "for context."

## Project knowledge

- [Overview & commands](project-overview.md) — what the app is, its three-column layout, and the `npm` commands.
- [Architecture](architecture.md) — main/preload/renderer split, the main-process subsystems, IPC surface, and every feature's behavior. It's large; **start at its [Map](architecture.md#map--start-here) section** — the `Files` table maps each `src/` module to the section that explains it, so you can jump straight to one section.
- [Status detection](status-detection.md) — how the colored status dots are driven by Claude Code hooks.
- [Platform notes](platform-notes.md) — Windows gotchas (node-pty fork, PTY path resolution, sandbox flag). **Do not revert these.**
- [Settings](settings.md) — the theme + language settings system (gear button), CSS-variable theming, and the i18n engine. How to add a theme, a language, or a translatable string.
- [Onboarding](onboarding.md) — the first-time-user aids: the spotlight guided tour, keyboard cheat sheet, welcome screen, and contextual hints. How to add a tour step, a hint, or a shortcut row.
- [Remote access](remote-access.md) — the mobile-companion feature: `server/` socket bridge (ws + relay + port-forward proxy), QR pairing, remote-bridge allowlist, the `mobile/` Expo app, and how to expose a channel to remote clients.
- [Desktop dialogs](desktop-dialogs.md) — every confirm/prompt/notice/warning/error/pickString modal: one layout (`shared/dialog.js`), one stylesheet (`.dlg` in `base.css`), and the entry points to call instead of hand-rolling one. Read before adding or restyling a desktop dialog.
- [Mobile design system](mobile-design.md) — how the phone app *looks*: `theme.ts` tokens, the `ui.tsx` primitives, `ScreenHeader`, the two motion signals, and the deliberate deviations from the design mock. Read before restyling a mobile screen.
- [Custom models (local)](custom-models.md) — running local open-source GGUF models in a session via an in-process node-llama-cpp engine + an in-process Anthropic⇄model proxy (the `ollama:` names are historical): the Settings section, install/uninstall, RAM/VRAM fit warnings, `ollama:`-namespaced dropdown merge, env routing, lifecycle/uninstall cleanup, and phone-side selection.
- [Testing](testing.md) — the test + lint setup and the Windows/macOS/Linux build workflow: what's covered, the pure-logic split that makes it testable, and how to add a test or a lint rule.

## Preferences

- [Icon style preference](icon-style-preference.md) — wants simple/minimal brand glyphs (Simple Icons), not busy Devicon logos, for file icons.
