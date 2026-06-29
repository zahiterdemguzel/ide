# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app for running and monitoring multiple interactive `claude` CLI sessions side by side. A top run toolbar spans the full width (a button per `.vscode/launch.json` config + per `tasks.json` task, each opening an external terminal). Below it, three columns: the left split 50/50 between a session list (top, colored status dots) and a file-tree explorer (bottom); the selected session's live terminal (center); and a git manager — stage/unstage/commit/push for one shared repo (right).

## Commands

- `npm install` — install deps (no native compile step; see docs/platform-notes.md).
- `npm start` — launch the app (`electron .`).
- `npm test` — run the unit tests (Node's built-in runner, zero test deps).
- `npm run lint` — ESLint over the whole tree.

No bundler and no build step for the app itself — vanilla JS loaded directly. The tests and lint cover the pure, Electron-free logic (config/JSONC translation, git porcelain parsing, per-session edit replay, i18n); run `npm run lint` + `npm test` locally before finishing a change. The only GitHub Actions workflow packages the Windows + macOS + Linux apps on every push to `master`. See [docs/testing.md](docs/testing.md).

## Documentation

Project knowledge lives in `docs/` (not in any external memory). These files are **read on demand, never all upfront** — this index is the only always-loaded part. From the descriptions below, open only the one file whose area your task touches, and read only the section you need (the docs cross-link, so follow a link when one points you elsewhere). Don't pre-read docs "for context."

- [docs/architecture.md](docs/architecture.md) — main/preload/renderer split, the main-process subsystems, IPC surface, and every feature's behavior. It's large; **start at its [Map](docs/architecture.md#map--start-here) section** — the `Files` table maps each `src/` module to the section that explains it, so you can jump straight to one section instead of reading the whole file.
- [docs/status-detection.md](docs/status-detection.md) — how the colored status dots are driven by Claude Code hooks.
- [docs/platform-notes.md](docs/platform-notes.md) — Windows gotchas (node-pty fork, PTY path resolution, sandbox flag). **Do not revert these.**
- [docs/settings.md](docs/settings.md) — the theme + language settings system (gear button), CSS-variable theming, and the i18n engine. How to add a theme, a language, or a translatable string.
- [docs/onboarding.md](docs/onboarding.md) — the first-time-user aids: the spotlight guided tour, keyboard cheat sheet, welcome screen, and contextual hints. How to add a tour step, a hint, or a shortcut row.
- [docs/testing.md](docs/testing.md) — the test + lint setup and the Windows/macOS/Linux build workflow: what's covered, the pure-logic split that makes it testable, and how to add a test or a lint rule.

## Working rules for agents

- **Keep docs in sync with code.** When you change behavior, add/edit/remove the matching file under `docs/` in the same change, and update the links above if you add or remove a doc. Docs that lie are worse than none.
- **Keep tests and lint green.** Run `npm test` and `npm run lint` before finishing a change. When you touch the pure logic (the modules listed in [docs/testing.md](docs/testing.md)), add or update a test in the same change; new behavior with no test is incomplete. Keep OS/IPC-touching code thin and push real logic into an Electron-free helper (`run-configs-lib.js`, `git-parse.js`, `edit-ops.js`) so it stays testable. Passing `npm test` and `npm run lint` is enough to consider a change verified — you do not need to launch the app to test it.
- **Write self-explanatory code.** Clear names, small functions, obvious control flow. Reserve comments for the non-obvious *why* (e.g. a platform workaround), not for restating *what* the code does. If a behavior needs prose to be understood, prefer making the code clearer first, then document the genuinely surprising part in `docs/`.
- **Conserve context.** Read only the doc section you need (use the architecture [Map](docs/architecture.md#map--start-here) and `Files` table), not whole files. Locate code with grep/glob, then read only the matched range. For broad cross-tree sweeps, delegate to an `Explore` agent so file dumps stay out of the main context. For most changes, read just the pure-logic helper + its test rather than the Electron wiring. Don't re-read a file after editing it.
