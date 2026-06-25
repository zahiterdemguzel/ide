# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app for running and monitoring multiple interactive `claude` CLI sessions side by side. Three columns: the left split 50/50 between a session list (top, colored status dots) and a file-tree explorer (bottom); the selected session's live terminal (center); and a git manager — stage/unstage/commit/push for one shared repo (right).

## Commands

- `npm install` — install deps (no native compile step; see docs/platform-notes.md).
- `npm start` — launch the app (`electron .`).

No build, lint, or test setup — vanilla JS, no bundler, no test framework.

## Documentation

Project knowledge lives in `docs/` (not in any external memory). Read the relevant file before changing that area:

- [docs/architecture.md](docs/architecture.md) — main/preload/renderer split, the three main-process subsystems, IPC surface.
- [docs/status-detection.md](docs/status-detection.md) — how the colored status dots are driven by Claude Code hooks.
- [docs/platform-notes.md](docs/platform-notes.md) — Windows gotchas (node-pty fork, PTY path resolution, sandbox flag). **Do not revert these.**

## Working rules for agents

- **Keep docs in sync with code.** When you change behavior, add/edit/remove the matching file under `docs/` in the same change, and update the links above if you add or remove a doc. Docs that lie are worse than none.
- **Write self-explanatory code.** Clear names, small functions, obvious control flow. Reserve comments for the non-obvious *why* (e.g. a platform workaround), not for restating *what* the code does. If a behavior needs prose to be understood, prefer making the code clearer first, then document the genuinely surprising part in `docs/`.
