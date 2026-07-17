# Codex CLI sessions (second agent provider)

The app can drive **OpenAI's Codex CLI** as a session agent alongside Claude Code. A session's model id encodes its provider: `codex:<model>` (e.g. `codex:gpt-5.5`) spawns the `codex` binary; `ollama:<name>` is the local-proxy route; everything else is the `claude` CLI. The seam is the pure module `src/main/agent-providers.js` (`modelFamily`, `canSwitchModel`, `codexSpawnArgs`), unit-tested in `test/agent-providers.test.js`.

## Family lock

A session may only switch models **within its family**, forever: claude→claude and codex→codex are allowed; ollama sessions are frozen entirely (no ollama→ollama either); cross-family is never allowed. Enforced in `set-session-model` (main, via `canSwitchModel`) and mirrored in every menu (desktop `switchableModels()` in `src/renderer/settings.js`; mobile `switchableModels()` in `mobile/src/api/models.ts`). The old live Claude↔Ollama respawn switch was removed by this rule.

## How the Codex spawn works (all verified against codex 0.142)

- **No `--session-id`**: Codex invents its own session UUID. The IDE keeps its own UUID as the canonical id everywhere; the Codex hook URL carries it as `?ide=<id>`, and `hook-server.js` rewrites `payload.session_id` back to ours (`normalizeHookPayload` in `hook-events.js`) while recording Codex's UUID on the session as `agentSessionId` (persisted — see `session-persist.js`).
- **Resume** = `codex resume <agentSessionId>`. A codex session with no recorded `agentSessionId` respawns fresh.
- **Hooks**: wired per-spawn via repeated `-c 'hooks.<Event>=[{hooks=[{type="command", command="curl…"}]}]'` overrides + `--dangerously-bypass-hook-trust` (never touches `~/.codex/config.toml`). Codex fires the same events as Claude plus `SubagentStart` (counted as a spawn signal in `deriveStatus`). Payloads are Claude-shaped (`session_id`, `transcript_path`, `cwd`, `tool_name: 'Bash'`, string `tool_input.command`), so status dots and push-sniff work unchanged.
- **Fs-diff tracking is serial for codex**: Codex runs tools one at a time but **skips `PostToolUse` when a tool errors** (observed with `apply_patch`), so the claude ref-count (`fsInFlight`) would jam above zero and silently drop the whole turn's file changes. Codex sessions instead use `serialFsPlan` (`fs-track.js`, tested): snapshot before each tracked tool, diff at its Post; an orphaned baseline is flushed by the next tracked Pre (catching the failed tool's changes) or by `Stop`. Codex authors edits via `apply_patch`/shell (no Write/Edit tools), so ALL its file changes flow through this fs diff — the Diff and "Commit N files" buttons work off the same `fileOps` as claude sessions.
- **Windows gotchas**: Codex runs hook commands through **PowerShell** — the command must say `curl.exe` (bare `curl` is the Invoke-WebRequest alias) and quote `'@-'` (bare `@-` is a PS parser error); PS stdin piping prepends a **UTF-8 BOM**, stripped in `hook-server.js` before `JSON.parse`.
- **Model/effort ride on the argv** (`--model`, `-c model_reasoning_effort=`), not env — so a live model/effort switch is a conversation-preserving **respawn** (`respawnSession` in sessions.js), not a `/model` keystroke plan (Codex's TUI picker isn't scriptable; `model-picker.js` is Claude-only). Typed-slash tracking (`feedSessionCommand`) is skipped for codex sessions.
- **Effort ladder**: `minimal|low|medium|high|xhigh` (no `max`) — `CODEX_EFFORT_LEVELS` / `effortLevelsFor(family)` in `agent-effort.js`; mobile `effortsFor()`. A new codex session starts on **`medium`** (`defaultEffortFor(family)`, applied in `new-session`), not unset — unlike claude sessions, which start with no `--effort` at all. `auto` stays a pickable stop (no `-c` override → Codex's own default).

## Transcript, asks, setup

- **Chat/mobile**: Codex's `transcript_path` is its rollout JSONL (`~/.codex/sessions/**`); `transcript-lib.js` sniffs the line shape (`isCodexEntry`) and `applyCodexEntry` maps `event_msg`/`response_item` records to the same chat-message shape, so `chat.js` and the phone are provider-blind.
- **Permission asks**: Codex `PermissionRequest` hooks feed the same `ask-lib.js` card; the yes key is `y` (Codex keymap default `approval.approve`), no is Esc (its stable `decline` binding). Family is threaded `sessions → chat.onHook(id, payload, family) → fromHook`.
- **Setup is optional**: picking a `codex:` model runs `ensureCodex()` (`src/renderer/claude-setup.js`, now a two-provider wizard over the same dialog DOM; codex wording under `setup.codex.*` i18n keys). Closing the wizard = "not now" — no session is created, nothing else blocks. Main probes via `check-codex` (`src/main/codex.js`: `codex --version`, `codex login status`; install guide in `codex-install.js` — npm install + `codex login`).
- **Model lists**: `CODEX_MODELS` in `src/renderer/settings.js` and its mirror in `mobile/src/api/models.ts` (keep in step): `codex:gpt-5.5`, `codex:gpt-5.4`, `codex:gpt-5.4-mini`. The Settings *subagent* dropdown excludes codex ids (Codex has no subagent-model override).

## Not ported (v1)

Per-session token/cost meter (no statusLine equivalent — Codex's `token_count` lives in the rollout JSONL), toolbar subscription usage meter (Anthropic-only), subagent model selection, Haiku naming/commit messages (still Claude-powered for every session).
