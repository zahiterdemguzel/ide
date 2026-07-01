# Project overview

## What this is

An Electron desktop app for running and monitoring multiple interactive `claude` CLI sessions side by side. A top run toolbar spans the full width (a button per `.vscode/launch.json` config + per `tasks.json` task, each opening an external terminal). Below it, three columns: the left split 50/50 between a session list (top, colored status dots) and a file-tree explorer (bottom); the selected session's live terminal (center); and a git manager — stage/unstage/commit/push for one shared repo (right).

## Commands

- `npm install` — install deps (no native compile step; see [platform-notes.md](platform-notes.md)).
- `npm start` — launch the app (`electron .`).
- `npm test` — run the unit tests (Node's built-in runner, zero test deps).
- `npm run lint` — ESLint over the whole tree.

No bundler and no build step for the app itself — vanilla JS loaded directly. The tests and lint cover the pure, Electron-free logic (config/JSONC translation, git porcelain parsing, per-session edit replay, i18n); run `npm run lint` + `npm test` locally before finishing a change. The only GitHub Actions workflow packages the Windows + macOS + Linux apps on every push to `master`. See [testing.md](testing.md).
