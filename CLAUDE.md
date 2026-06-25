# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app for running and monitoring multiple interactive `claude` CLI sessions side by side. Three panes: session list (left, with colored status dots), the selected session's live terminal (center), and a git stage/unstage manager for one shared repo (right).

## Commands

- `npm install` — installs deps. No native compile step (see node-pty note below).
- `npm start` — launches the app (`electron .`).

No build, lint, or test setup — vanilla JS, no bundler, no test framework.

## Architecture

Standard Electron main/preload/renderer split. The renderer is pure UI and has **no** Node/OS access; everything that touches the OS lives in the main process and is reached over IPC defined in `preload.js`.

- **`main.js`** (main process) owns three subsystems:
  1. **PTY manager** — one `pty.spawn('claude', ...)` per session, keyed by a generated UUID. The UUID is passed as `--session-id` so it round-trips into hook payloads (this is how a hook event is correlated back to its sidebar row).
  2. **Hook → status server** — a Node `http` server on a random `127.0.0.1` port. Each spawned `claude` gets hooks injected **via the `--settings` flag as inline JSON** (`hooksSettings()`), so the user's global `~/.claude/settings.json` is never modified. Every hook is a `command` hook that `curl`s its stdin payload to this server. `eventToState()` maps `hook_event_name` → one of `working` / `needs-input` / `completed` / `pushed`, which is pushed to the renderer. The push→purple state is detected by matching `git push` in a `PostToolUse` Bash command.
  3. **Git** — plain `git` porcelain via `execFile` in `repoPath` (no git library). `git status --porcelain=v1` is parsed into staged/unstaged lists; stage = `git add`, unstage = `git reset HEAD` (falls back to `git rm --cached` for repos with no commits yet).
- **`renderer.js`** keeps a `Map` of sessions, each owning its own xterm.js `Terminal` in a hidden container div; switching sessions just toggles which container is visible (preserves scrollback). `setState()` drives the status-dot CSS class.
- **`preload.js`** — the entire IPC surface (`contextBridge`). Add a channel here when wiring new main↔renderer calls.

## Things to know before changing

- **node-pty:** uses `@homebridge/node-pty-prebuilt-multiarch`, NOT upstream `node-pty`. Upstream fails to compile on Windows (missing winpty submodule `GetCommitHash.bat`). The prebuilt fork's Windows binary is N-API, so the Node-ABI prebuild loads fine under Electron — do not add `electron-rebuild` or swap back to `node-pty`.
- **Executable resolution:** node-pty on Windows does NOT search PATH, so `pty.spawn` needs a full path. `resolveClaude()` runs `where claude` once and caches it; don't revert to spawning bare `'claude'`.
- **Hook event names** (`main.js` `events[]`) are the load-bearing assumption for auto-status. If status dots never change, a CLI-version event-name mismatch is the first suspect. Unknown event names are harmless (they simply never fire).
- **`sandbox: false`** in the BrowserWindow is intentional — the preload requires the native node-pty module. Keep `contextIsolation: true` / `nodeIntegration: false`.
- Hook delivery relies on `curl` being on PATH (ships with Windows 11).
