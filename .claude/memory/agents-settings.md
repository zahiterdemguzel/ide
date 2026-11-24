# Agents settings page

Settings → **Agents** lists, creates, edits and deletes the open project's custom
agents for both providers. Storage is the project's own files, so it is per
repository and travels with git:

- Claude Code: `.claude/agents/<id>.md` — YAML frontmatter (`name`, `description`, `tools`, `model`, `color`) + Markdown system prompt.
- Codex: `.codex/agents/<id>.toml` — `name`, `description`, `model`, `model_reasoning_effort`, `sandbox_mode`, `developer_instructions`.

**Files.** `src/main/agents-lib.js` (pure parse/serialize/validate, tested in
`test/agents-lib.test.js`), `src/main/agents.js` (file IO + `agents-list` /
`agents-save` / `agents-delete` IPC), `src/preload/agents.js`,
`src/renderer/agents-settings.js` (lists + form), `src/styles/agents.css`.

**Behavior.**
- The project root is `getMainRepoPath()`, not the active worktree, so every worktree session edits one list.
- Anything the form doesn't model (unknown frontmatter keys, TOML tables like `[mcp_servers.x]`) is kept verbatim in `extra` and written back, so a UI edit never drops hand-written settings.
- Editing keeps the file name; a new agent gets `slugify(name)` (`-2`, `-3` on collision). Ids are validated (`isSafeAgentId`) before touching disk. Writes are atomic.
- Claude agents require a lowercase-hyphen name, description and instructions (`agentProblem`); errors come back as i18n keys.
- The page refreshes on every settings open and on `applyRepoChange`. There is no file watcher, so edits made outside the app show up on the next open.
- i18n: page title key is `settings.agentsPage` (`settings.agents` is the older "Agent models" group on the Sessions page).
