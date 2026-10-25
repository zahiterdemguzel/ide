# Project memory

Index of what's worth remembering about this project. Each line links to a detail file — these are **read on demand, never all upfront**. Open only the one file whose area your task touches, and read only the section you need (they cross-link, so follow a link when one points you elsewhere). Don't pre-read them "for context."

## Project knowledge

- [Overview & commands](project-overview.md) — what the app is, its three-column layout, and the `npm` commands.
- [Architecture](architecture.md) — main/preload/renderer split, the main-process subsystems, IPC surface, and every feature's behavior. It's large; **start at its [Map](architecture.md#map--start-here) section** — the `Files` table maps each `src/` module to the section that explains it, so you can jump straight to one section.
- [Status detection](status-detection.md) — how the colored status dots are driven by Claude Code hooks.
- [Platform notes](platform-notes.md) — Windows gotchas (node-pty fork, PTY path resolution, sandbox flag). **Do not revert these.**
- [Settings](settings.md) — the theme + language settings system (gear button), CSS-variable theming, and the i18n engine. How to add a theme, a language, or a translatable string.
- [Onboarding](onboarding.md) — the first-time-user aids: the spotlight guided tour, keyboard cheat sheet, welcome screen, and contextual hints. How to add a tour step, a hint, or a shortcut row.
- [Remote access](remote-access.md) — the mobile-companion feature: `server/` socket bridge (ws + relay + port-forward proxy), Steam-style direct WebRTC links the relay only introduces (relay as fallback), QR pairing, remote-bridge allowlist, the `mobile/` Expo app, and how to expose a channel to remote clients.
- [Desktop dialogs](desktop-dialogs.md) — every confirm/prompt/notice/warning/error/pickString modal: one layout (`shared/dialog.js`), one stylesheet (`.dlg` in `base.css`), and the entry points to call instead of hand-rolling one. Read before adding or restyling a desktop dialog.
- [Mobile design system](mobile-design.md) — how the phone app *looks*: `theme.ts` tokens, the `ui.tsx` primitives, `ScreenHeader`, the two motion signals, and the deliberate deviations from the design mock. Read before restyling a mobile screen.
- [Codex CLI sessions](codex.md) — the second agent provider: `codex:` model ids spawn OpenAI's Codex CLI with full feature parity (hooks/status/commit/mobile chat/asks/resume). The provider seam (`agent-providers.js`), the family lock on model switching, the `?ide=` session-id mapping, and the Windows PowerShell hook gotchas.
- [Custom models (local)](custom-models.md) — running local open-source GGUF models in a session via an in-process node-llama-cpp engine + an in-process Anthropic⇄model proxy (the `ollama:` names are historical): the Settings section, install/uninstall, RAM/VRAM fit warnings, `ollama:`-namespaced dropdown merge, env routing, lifecycle/uninstall cleanup, and phone-side selection.
- [Voice input](voice-input.md) — dictate into the focused session: while a session terminal holds the caret, offline Whisper (sherpa-onnx) transcribes speech and types it into that session. The focus-driven trigger and its guards, the phrase-at-a-pause VAD design, the spoken-language setting, the latency/thread-count trade-off, the hallucination filter, and the install-time model fetch.
- [Diagram panel](diagram.md) — the center-area panel that draws the project's structure (classes, dependencies, calls) from a tree-sitter index laid out with elkjs: the worker split, the seven supported languages (six via wasm grammars, GDScript via a hand-written scanner), how names are resolved to definitions, and the five views + seven pass switches. Read before touching code extraction or the diagram UI.
- [Worktree sessions](worktrees.md) — the per-project toggle that gives every new session its own git worktree + branch: the active-tree vs project split in `repo.js`, the seeding copy of untracked/ignored files, Merge instead of Commit, and why those sessions turn filesystem tracking off.
- [Debugger](debugger.md) — the DAP debugger for launch.json configs (debugpy so far): starting/attaching sessions, the handshake, gutter breakpoints that follow edits, the debug drawer, F-key bindings, and how to add another adapter.
- [Code editor](editor.md) — the Monaco-based editor (`viewer/file.js` + `renderer/editor/`): document model and disk-conflict handling, preview tabs, gutter (breakpoints, git bars, blame), status bar/Problems, keybindings, Markdown/HTML preview, Settings → Editor. Read before touching the editor.
- [Language servers](lsp.md) — the editor's LSP stack: main-process stdio/TCP pipe (`lsp.js`/`lsp-lib.js`), bundled pyright + TypeScript native LSP, PATH discovery for other servers, Godot over TCP, and the renderer client (`editor/lsp-client.js`) that maps LSP onto Monaco providers.
- [AI assist](ai-assist.md) — Cursor-style editor AI: ghost-text completions, Cmd/Ctrl+K inline edit with diff review, Cmd/Ctrl+L add-to-session, AI quick fixes; Messages API via the Claude Code OAuth token (`ai-assist.js`/`ai-assist-lib.js`, `editor/ai.js`).
- [Claude accounts](accounts.md) — several Claude logins side by side, switched from the toolbar pill: one `CLAUDE_CONFIG_DIR` folder per account with `~/.claude` shared via symlinks, per-account Keychain/usage, open sessions resuming on the new account, the 95%-of-5-hour switch prompt, and expired-login detection with one-click Renew.
- [Testing](testing.md) — the test + lint setup and the Windows/macOS/Linux build workflow: what's covered, the pure-logic split that makes it testable, and how to add a test or a lint rule.

## Preferences

- [Icon style preference](icon-style-preference.md) — wants simple/minimal brand glyphs (Simple Icons), not busy Devicon logos, for file icons.
