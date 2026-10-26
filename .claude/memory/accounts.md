# Claude accounts — switch logins without signing out

Several Claude subscriptions can live on one machine at once. A pill in the top
toolbar (left of the usage meter) names the **active account**; its menu lists every
account with its 5-hour usage, switches with one click, and adds / renames /
re-signs-in / removes accounts. New sessions spawn as the active account, and a
switch moves the open sessions over too.

## How an account is isolated

Claude Code reads its whole config — including the login — from `CLAUDE_CONFIG_DIR`
(default `~/.claude`). So an extra account is just **its own config folder**,
`~/.claude-accounts/<slug>`, and running the CLI with that env var *is* being that
account. The built-in **default** account is the user's normal setup: no env override.

- **Store**: `~/.claude-accounts/accounts.json` (`{activeId, defaultName, accounts:[{id,name,configDir}], removedDirs}`),
  beside the account folders — **not** in the app's data folder, because the dev build and the installed
  app each get their own (`-dev` suffix, `instance.js`), so a list kept there vanished when the other build
  was opened. Read fresh on every call so all app instances agree. Shape logic: `accounts-lib.js`.
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

## Switching moves open sessions

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
(`rankSwitchTargets`: most 5-hour headroom), each with its own usage bar (fetched via
`accounts-usage`, one 1-token call per account). With no other signed-in account it
offers "Add account" instead. The prompt also says the 98% auto-switch exists.

## The 98% automatic switch (unattended use)

The user leaves sessions running while away, so past `AUTO_SWITCH_THRESHOLD` (98%)
of **either** window (`autoSwitchKey`, one key per window + reset, stored with the
asked-keys) `onUsage` switches without asking — only when `pickAutoSwitchTarget`
finds an account that is signed in, has a fresh usage reading, has **no 7-day
window** (no weekly limit — a hard rule from the user: never auto-switch to a
weekly-limited account), and sits below 95% of its 5-hour window. No such account →
nothing happens, the 95% prompt still shows, and it retries at most every 5 min.
It isn't held back by an open prompt: the notice it shows (singleton
`account-switch`) replaces a still-open 95% question. For this to work while the
window is unfocused, `initUsageMeter({ pollInBackground })` keeps the 30s poll
running in the background whenever `wantsBackgroundUsage()` (more than one
signed-in account).

**Cut-off turns carry on.** A turn that runs into the limit ends with a
`StopFailure` hook (`error: 'rate_limit'`) instead of `Stop` (see
[status-detection.md](status-detection.md)); `recordSessionActivity` sets
`s.cutOffByUsageLimit` (cleared by the next main-thread prompt). When that session
moves to another account (`moveToActiveAccount`), `continueOnceResumed` waits for
the resumed TUI to go quiet (2s, 30s cap) and types a "continue where you left off"
prompt — so the work goes on unattended.

## UI

Markup: `#account-switcher` in `index.html`. Styles: the `.acct-*` block at the end of
`toolbar.css` (pill = session-bar badge look; the menu is `position: fixed` because
`#toolbar` clips overflow). Rows (`accountRow`) are shared by the menu and the prompt.
The sign-in dialog widens itself with `.dlg.is-wide` (`base.css`). Strings: `accounts.*`.
