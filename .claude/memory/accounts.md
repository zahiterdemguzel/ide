# Claude accounts — switch logins without signing out

Several Claude subscriptions can live on one machine at once. A pill in the top
toolbar (left of the usage meter) names the **active account**; its menu lists every
account with its 5-hour and weekly usage (bar, %, and reset countdown each), switches with one click, and adds / renames /
re-signs-in / removes accounts. New sessions spawn as the active account, and a
switch moves the open sessions over too — **without restarting them**, through the
account proxy (below). **Each app instance (window process) has its own active
account**: switching in one window never touches another window's sessions.

## How an account is isolated

Claude Code reads its whole config — including the login — from `CLAUDE_CONFIG_DIR`
(default `~/.claude`). So an extra account is just **its own config folder**,
`~/.claude-accounts/<slug>`, and running the CLI with that env var *is* being that
account. The built-in **default** account is the user's normal setup: no env override.

- **Store**: `~/.claude-accounts/accounts.json` (`{activeId, defaultName, defaultAutoSwitch, accounts:[{id,name,configDir,autoSwitch}], removedDirs}`),
  beside the account folders — **not** in the app's data folder, because the dev build and the installed
  app each get their own (`-dev` suffix, `instance.js`), so a list kept there vanished when the other build
  was opened. Read fresh on every call so all app instances agree on the *list*. Shape logic: `accounts-lib.js`.
- **Active account is per instance**: `instanceActiveId` in `accounts.js`, in memory. The store's
  `activeId` is only the latest choice made in any window, read once at launch so a new window starts
  on it. `activeAccount()` = `resolveActiveAccount(store, instanceActiveId)` (falls back to default if
  another window removed that account). Everything that "uses the active account" — spawns, the
  proxy, Haiku/AI assist, the usage meter, `runCli` — therefore follows this window's choice.
- **Persistence across restarts / builds** (`restoreAccounts()`, once per launch): first run migrates the
  newest legacy `<userData>/accounts.json` (this build's or its dev/packaged twin); then `recoverAccounts`
  re-adds any folder under `~/.claude-accounts` that still holds a login but is missing from the list
  (id `dir-<folder>`, named from `.claude.json`'s org, or email for a personal org). Folders the user
  removed are kept in `removedDirs` so they stay removed; never-signed-in folders are ignored.
- **Login**: "Add account" creates the folder, then a dialog embeds a terminal running
  `claude auth login` with that env (`accounts-login-command` → `term-create` with
  `args`+`env`). The command exits when the browser login completes and the dialog
  closes itself. Status/email come from `claude auth status --json` per account.
- **Credentials per account**: on macOS the CLI stores each config folder's login under
  its own Keychain service, `Claude Code-credentials-<first 8 hex of sha256(configDir)>`
  (read off the CLI bundle, 2.1.x — `keychainServiceFor`). On Linux/Windows it's
  `<configDir>/.credentials.json`. `claude.js`'s `readOauthToken(configDir)` /
  `readUsage(configDir)` take the folder; with no argument they use the active account,
  so Haiku generation, AI assist (its token cache is keyed by account) and the usage
  meter all follow the switch. `runCli` also runs as the active account.
- **Shared config**: an account folder would otherwise start empty — no `CLAUDE.md`,
  settings, plugins, skills, and no session transcripts. `linkSharedConfig()` symlinks
  an **allowlist** of `~/.claude` entries in (`SHARED_CONFIG_ENTRIES`; Windows dirs use
  junctions), re-checked before every spawn so later additions reach every account.
  Never shared: credentials, `.claude.json` (holds `oauthAccount`), org policy/remote
  settings, telemetry, daemon files. A new account's own `.claude.json` is **seeded**
  from `~/.claude.json` (onboarding done, theme, MCP servers, trusted projects — not
  the login identity) so the CLI skips first-run setup.
- **Removing** an account only forgets it: the folder is full of links into `~/.claude`
  and a recursive delete isn't worth the risk. Removing the active one switches to
  default first.

## API-key accounts

An account has a `kind`: `'claude'` (a claude.ai login, the default) or `'apiKey'` (an
Anthropic API key). "Add account" first asks which (dialog: Claude account / API key),
then the name; a login is signed in as before, a key is asked for in a password field.
Main checks the key with a free `GET /v1/models` (401/403 → `{ error: 'rejected' }`,
the renderer re-asks with the reason; offline is accepted) before creating the account.

- **Storage**: still its own folder under `~/.claude-accounts` (shared config links,
  seeded `.claude.json`), plus `.ide-api-key` (mode 0600) holding the key as
  `enc:<base64>` via Electron `safeStorage`, or `plain:<key>` when the OS offers no
  encryption (`encodeStoredApiKey`/`decodeStoredApiKey`). The key's last 20 chars are
  added to `.claude.json` `customApiKeyResponses.approved` (`approveApiKeyInConfig`) so
  the CLI doesn't ask "use this API key?" on every session.
- **Spawning**: `accounts.spawnEnv(account)` = `CLAUDE_CONFIG_DIR` + `ANTHROPIC_API_KEY`;
  `runCli` gets the same via `accountEnvForConfigDir`. The CLI's own `primaryApiKey` in
  `.claude.json` is **not** used: `claude auth status` reports it, but API calls still
  say "Not logged in" (checked on CLI 2.1.322).
- **Not proxied**: the key in the spawn env makes `canRouteThroughProxy` false, so these
  sessions move by restart. The other way round, switching *to* an API-key account
  restarts proxied sessions too (`planAccountMove(..., { activeIsApiKey })`) — the proxy
  only swaps claude.ai logins, and skips swapping while an API-key account is active.
- **No usage / login check**: `describeAccounts` reports `loggedIn` = has a key, the
  masked key (`maskApiKey`) in `email`; `accounts-usage` returns null for them. Never
  auto-switch targets (`pickAutoSwitchTarget` excludes `kind: 'apiKey'`, created with
  `autoSwitch: false`, no lightning toggle). The menu row shows "API key · sk-ant-…abcd"
  and a key icon (Change API key → `accounts-set-api-key`) in place of Sign in.
- **Recovery**: a folder with `.ide-api-key` is recovered as an API-key account.

### Spending limit (API-key accounts)

A dollar limit per API-key account, **monthly** (starts over on the 1st, local time) or
**total** (until "Reset spent"), set from the menu row's $ icon and offered right after
adding a key (`editSpendingLimit`; empty amount = no limit). Stored in
`<folder>/.ide-budget.json` (`{limitUsd, period, spentUsd, periodStart}`); pure logic in
`api-spend-lib.js`.

- **Metering**: API-key sessions *are* routed through the account proxy, but only to be
  counted: their base URL is `http://127.0.0.1:<port>/k/<accountId>` (`proxyRouteEnv`,
  allowed by `canMeterThroughProxy`), `viaAccountProxy` stays false so they still move by
  restart. The proxy strips the prefix, forwards with the session's own key (no login
  swap), drops `accept-encoding` on billed calls so the body is readable, and feeds the
  response to `createUsageReader` (SSE `message_start` + `message_delta`, or JSON). On end
  (or close — an interrupted stream was still billed) `costOfUsage` prices it from the
  local price table and `recordApiSpend` adds it. **Prices are hardcoded** (first-party
  list, 2026-11) — update `MODEL_PRICES` when Anthropic changes them. Only
  `POST /v1/messages` counts; the app's own `claude -p` helpers (commit messages etc.) are
  not metered.
- **Enforcement**: once `spentUsd >= limitUsd` the proxy answers billed calls with a 400
  `invalid_request_error` naming the limit (the CLI shows it and stops; a 429 would be retried).
- **Display**: `budgetUsageView` turns the budget into a usage window `key: 'budget'` (with
  `spentUsd`/`limitUsd`), returned by `get-usage` (active account) and `accounts-usage`, so
  the toolbar meter and menu rows draw it like the 5h/weekly bars, showing "$X left"
  where the reset countdown sits. Since it's a window, the 98% auto-switch also leaves an
  API-key account whose limit is nearly spent (the 95% prompt only watches the 5-hour window).

## The account proxy — switching without a restart

`account-proxy.js` (pure parts in `account-proxy-lib.js`, tested): a loopback HTTP server, **one per
app instance**, started lazily on the first Claude spawn (`ensureAccountProxy()` → port, or null if it
can't listen). `spawnPty` adds `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` to every Claude session
(`accountProxyRoute`, marks `s.viaAccountProxy`). The proxy forwards each request to
`api.anthropic.com` **byte for byte**, except that a request carrying an OAuth bearer
(`carriesClaudeLogin`) gets the login of the account active in this instance instead of the session's
own (`upstreamHeaders`). So a switch is just a different header on the next request — mid-turn
included; the CLI never notices. Verified against the real API (CLI 2.1.310): the CLI sends its
OAuth bearer to a custom base URL without any extra env, responses carry the new account's org id
and rate-limit headers.

- **Cost**: the body is untouched, so prompt caching works as before. Caches are per org, so the
  first request after a switch writes the conversation into the new account's cache once (measured
  ~20k tokens on a 33k context), then reads resume. Restart-and-resume paid the same.
- **Logins**: read with `readOauthCredsAsync` (non-blocking Keychain), cached per account
  (`isCachedLoginFresh`: re-read every 60s or near expiry; cache cleared on a switch). A login that
  ran out with a refresh token (`loginAction` → `renew`) is renewed by a one-line `runCli` as that
  account — **never refreshed by the proxy itself** (refresh tokens rotate). No usable login → the
  request keeps the session's own.
- **401** from an injected login (`isLoginRefused`): re-read; if the stored login is still the
  refused one, renew via the CLI; retry once. Without this the CLI would try to renew *its own*
  login for a refusal that wasn't about it.
- **Not routed** (`canRouteThroughProxy`): a session whose spawn env or `settings.json` `env` sets a
  base URL, API key, auth token, OAuth-token env or a 3P provider — the proxy only stands in for a
  claude.ai login. Codex and local-model sessions never are. Those, and every session if the proxy
  can't start, fall back to the restart move below.
- **What doesn't move**: `/status` inside the TUI still names the account the session spawned as
  (its `CLAUDE_CONFIG_DIR`); only API traffic through the base URL moves. Esc mid-stream closes the
  client socket, which destroys the upstream request.

## Fallback: switching by restart

For a session *not* behind the proxy (`proxied: false` in `accountMoveView`):
`spawnPty` stamps each Claude session with the `accountId` it spawned as and adds
`CLAUDE_CONFIG_DIR`; `ensureFolderTrusted` writes into that account's `.claude.json`.
On a switch (`setActiveAccount` → `onActiveAccountChanged`), `planAccountMove` splits
the live Claude sessions on another account: **idle ones respawn now** with
`--resume <id>` (`respawnSession`) — the conversation continues because `projects/`
is shared — and **busy ones** (`working`, `bg-agents`, `needs-input`) move when
`setSessionState` sees them settle (`shouldMoveAfterState`, deferred 500ms so the hook
that settled them gets its answer first). Suspended sessions just resume as whichever
account is active. Codex and local-model sessions never move.

## Expired logins

`claude auth status` only checks that credentials are *stored* (no network), so it
can't see an expired login. `describeAccounts` therefore adds a **login check** per
signed-in account (`checkLogin` in `accounts.js`, cached 5 min per account; the
`accounts-list` IPC takes `{recheck}` to bypass it): read the stored login
(`readOauthCreds` → pure `pickOauthCreds`, expired or not), make one 1-token API call
with it (`probeOauthToken` → HTTP status, 0 = unreachable), and classify with the pure
`classifyLogin`: `ok` / `stale` / `expired` / `none`. **Offline never reads as
expired.** `stale` (access token ran out, refresh token present — normal for an
account no session has used for hours) is handed to the CLI for a one-line
`runCli('.', {configDir})`, which renews the token from the refresh token exactly as a
session would; only a login still unusable after that is `expired`. Never refresh the
token ourselves: refresh tokens rotate, and a renewal the CLI didn't store would sign
the account out.

An expired account reports `loggedIn: false` + `login: 'expired'`, so it drops out of
the switch targets and its row click signs in. The menu row shows "Login expired" in
red with an always-visible **Renew** button (one click → `claude auth login` dialog);
the toolbar avatar gets a red ring when the active account is expired. The renderer
asks **once per login** "sign in again?" (`reloginPromptKey` = account + the login's
`expiresAt`, stored with the other asked-keys in `ide.accountSwitchPrompted`), one
question at a time with the switch prompt. Checks run on startup, on menu open, every
5 min while focused, and immediately (`recheck`) when the active account's usage
reading goes blank after having data — the first visible sign of a lapsed login.
After a sign-in the list is re-read with `recheck` so the stale result is dropped.

## The 95% prompt

`usage-meter.js` emits every reading as a `usage-updated` window event. `accounts.js`
asks `switchPromptKey(activeId, view)` (pure, `shared/account-switch.js`): at ≥95% of
the **5-hour** window it returns `<account>:<resetAt>`, and the dialog is shown once
per key (remembered in `localStorage` `ide.accountSwitchPrompted`), so "Not now" holds
until that window resets. The dialog lists the other signed-in accounts best-first
(`rankSwitchTargets`: most 5-hour headroom), each with its own usage bars (fetched via
`accounts-usage`, one 1-token call per account). With no other signed-in account it
offers "Add account" instead. The prompt also says the 98% auto-switch exists.

## The 98% automatic switch (unattended use)

The user leaves sessions running while away, so past `AUTO_SWITCH_THRESHOLD` (98%)
of **either** window (`autoSwitchKey`, one key per window + reset, stored with the
asked-keys) `onUsage` switches without asking — only when `pickAutoSwitchTarget`
finds an account that the user **allowed for auto-switching** (per-account
`autoSwitch` flag, default on), is signed in, has a fresh usage reading, and sits
below 95% of **every** window (5-hour and weekly). Weekly-limited accounts used to
be excluded outright; that rule was dropped once every account had a weekly limit.
No such account →
nothing happens, the 95% prompt still shows, and it retries at most every 5 min.
It isn't held back by an open prompt. Any switch of the active account (this
auto-switch, the menu, another device) bumps `accountGeneration` and cancels the
95% prompt through the close handle it registered (`closeSwitchPrompt`); a prompt
still reading usage when the switch lands sees the generation changed and never
opens. The auto-switch then shows its own notice (singleton `account-switch`). For this to work while the
window is unfocused, `initUsageMeter({ pollInBackground })` keeps the 30s poll
running in the background whenever `wantsBackgroundUsage()` (more than one
signed-in account).

**Cut-off turns carry on.** A turn that runs into the limit ends with a
`StopFailure` hook (`error: 'rate_limit'`) instead of `Stop` (see
[status-detection.md](status-detection.md)); `recordSessionActivity` sets
`s.cutOffByUsageLimit` (cleared by the next main-thread prompt). When that session
moves to another account, it gets a "Continue" prompt typed in (`continueCutOffTurn`)
— right away for a proxied session (it is idle and already on the new account), or,
after a restart move, once `continueOnceResumed` sees the resumed TUI go quiet (2s,
30s cap) — so the work goes on unattended.

## UI

Markup: `#account-switcher` in `index.html`. Styles: the `.acct-*` block at the end of
`toolbar.css` (pill = session-bar badge look; the menu is `position: fixed` because
`#toolbar` clips overflow). Rows (`accountRow`) are shared by the menu and the prompt;
each takes the account's full usage reading and shows both windows stacked like the
toolbar meter (`usageMeter`: label · bar · % · reset glyph + countdown, "resets in …" in the tooltip; windows picked and
ordered by the tested `rowUsageWindows`).
Each menu row's hover actions include a lightning toggle (`autoSwitchToggle` →
`accounts-set-auto-switch` → `setAccountAutoSwitch`) that opts the account in or out
of the 98% auto-switch; manual switching ignores it. An opted-out row shows a
struck-through lightning mark (`.acct-noauto`) when not hovered.
The sign-in dialog widens itself with `.dlg.is-wide` (`base.css`). Strings: `accounts.*`.

## Codex and Evren tabs

The account menu has three tabs — **Codex · Claude · Evren** — each with its own
selected entry per app instance, so the three are chosen independently. Claude (the
default tab) is everything above; the toolbar pill and usage meter follow only it.
Code: `provider-accounts.js` (disk + IPC `providers-*`), pure `provider-accounts-lib.js`
(tested), list in `~/.claude-accounts/providers.json` (mode 0600).

Both providers reuse the account proxy: its routes `/e/…` (Evren) and `/c/…` (Codex) forward
byte for byte to the provider with the **active entry's credentials** in place of the session's
own, so a switch needs no restart. Sessions always run in the default config (`~/.claude`,
`~/.codex`); only credentials differ.

- **Evren**: keys stored encrypted (`safeStorage`) in `providers.json`. A model id `evren:<name>`
  (`EVREN_MODELS` in `renderer/settings.js`) is family `evren` (frozen for life like `ollama:`):
  it spawns the `claude` CLI with `evrenSpawnEnv` — `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/e`,
  a placeholder `ANTHROPIC_AUTH_TOKEN` the proxy swaps for `Authorization: Bearer <active key>`,
  every Claude alias mapped to `glm-5.3` (haiku → `qwen3.8-flash-next`). Upstream
  `evren-llmapi.ssyz.org.tr`. Key check is `GET /v1/quota` (only 401 = rejected; 403
  `terms_not_accepted` means the owner must accept Evren's terms first). Picking an Evren model with
  no key opens the add-key dialog (`ensureEvrenKey`). No usage/quota display yet (`GET /v1/quota` exists).
- **Codex**: an account is a `CODEX_HOME` folder under `~/.codex-accounts/<name>` holding a
  `codex login`; the default entry is `~/.codex`. Codex spawns get
  `-c chatgpt_base_url="http://127.0.0.1:<port>/c/backend-api/"` (verified with codex 0.171: all
  backend traffic then carries `Authorization` + `chatgpt-account-id`, which the proxy replaces from the
  active account's `auth.json`). A token that ran out is renewed by running `codex login status` as that
  home — never refreshed by the proxy. No usable login → the session's own credentials pass through.
  A WebSocket upgrade on `/c/` is tunneled. **Not verified**: a full `/codex/responses` turn through the
  proxy, and logins kept in the OS keyring instead of `auth.json` (those read as signed out).
- Mobile app: still sees `evren:` ids as Claude family (not ported).
- **ChatGPT in Claude Code** (`chatgpt:sol|astra|terra|luna`, family `chatgpt`, frozen for life): the
  `claude` CLI against the proxy's `/g` route (`chatgptSpawnEnv`; aliases `sol…luna` are the model names the CLI
  sends). The route is `chatgpt-route.js` (Electron-free, tested end to end against a fake backend in `test/chatgpt-route.test.js`); `chatgpt-translate-lib.js` (tested) turns Anthropic Messages into the Codex backend's Responses request
  (`chatgpt.com/backend-api/codex/responses`: `store:false`, `stream:true`, non-empty `instructions` — all
  required, a bad body gets `400 Store must be set to false`) and the SSE stream back (text, function calls →
  `tool_use`, usage; effort from `output_config.effort` or the thinking budget; reasoning events dropped, thinking blocks never replayed). Uses the **Codex tab's active
  account**. `count_tokens` is estimated locally (chars/4). Model = `resolveCurrentModelId('codex:<family>')`.
  **Not verified live**: the request shape passes the backend's validation, but a full answer stream was never
  seen (the account was at its weekly limit) — response event names follow the public Responses API.
  Using a ChatGPT subscription token outside the Codex CLI may conflict with OpenAI's terms; unchecked.
