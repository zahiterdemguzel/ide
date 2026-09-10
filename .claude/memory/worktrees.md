# Worktree sessions

Per-project mode: with it on, **every new session gets its own git worktree and branch**, so several sessions can build, run and test in parallel without sharing one working tree. Existing sessions are never converted — the toggle only decides what the *next* session is.

Files: `src/main/worktrees-lib.js` (pure), `src/main/worktrees.js` (IO + IPC), `src/main/session-merge.js`, `src/main/project-settings{,-lib}.js`, `src/renderer/worktrees.js`, plus the worktree branches in `sessions.js`, `session-commit.js`, `session-persist.js`, `repo.js` and `renderer/sessions.js`.

## The one idea that makes it cheap

`repo.js` already had a single `repoPath` that every subsystem derives from — explorer watcher, `.vscode` launch/task watcher, diagram, DB, remote — plus a `folder-changed` event the renderer turns into `applyRepoChange()`. Worktree support is mostly **pointing that one path at a worktree**:

- `repoPath` — the **project** the user opened. Recent folders, the window title, per-project settings and the session-list filter all key on this. `getMainRepoPath()`.
- `activeWorktree` — set while a worktree session is selected. `getRepoPath()` returns `activeWorktree || repoPath`, so git, the explorer, launch configs and tasks follow with **no change of their own**.

`setRepoPath()` (project switch) always clears `activeWorktree`; `setActiveWorktree()` never touches the recent list — a worktree must never become the folder the app reopens next launch. Both go through `notifyRepoChange()`, which stamps an incrementing `epoch` on `folder-changed`; the renderer drops any payload older than the newest it has applied, because focus-follow fires switches back to back.

**`applyRepoChange()` treats a worktree switch differently in exactly two ways**: it passes `setSessionsRepo(r.main)` (the list filters on the project, so passing a worktree would empty it) and it resets the consoles **only when the project itself changed**, tracked in `currentProject`. Selecting a session must never kill the dev server a launch config is running -- in either direction, including worktree back to project; existing terminals keep the cwd they were spawned with, and only new ones follow the active tree.

Both of those depend on the `folder-changed` payload arriving **whole**: `onFolderChanged` forwards `{...msg}`, because `main`/`worktree`/`epoch` are the only things distinguishing a worktree switch from a project one. Forwarding just `repo` (as the pre-worktree renderer did) makes every worktree switch look like opening a new project, which empties the session list and resets the consoles.

## Session fields

`s.repo` stays the **project root** — it is the session's identity, what `query-sessions` filters on, and what per-project settings key on. The tree it actually runs in is separate:

| field | meaning |
|---|---|
| `worktree` | absolute path of its checkout, `''` for an ordinary session |
| `branch` | the branch its work lives on (`ide/sess-<id8>`) |
| `baseBranch` | the branch it was created from, and merges back into |
| `worktreeState` | `'ready'` · `'missing'` (directory gone from disk) · `''` |

`sessionCwd(s)` = `worktree || repo`, and is what `spawnPty` and every git call use. A `'missing'` worktree falls back to the project, so the session degrades to "works, but no longer isolated" instead of failing to spawn.

All four fields are persisted (`session-persist.js`). A snapshot caught mid-copy (`'preparing'`) deserializes as `'missing'` — it describes a half-seeded tree. `isSessionPersistable()` accepts a worktree session with no prompt and no edits: the record is the only thing pointing at a real directory and branch.

## Creating one

1. Read the toggle from **main's own store**, never a client-supplied flag (a stale renderer or phone must not decide the kind of session). `forceMainTree` is the one deliberate override.
2. Preconditions: a git repo, **with at least one commit** (`worktree add` can't resolve an unborn HEAD) and **not detached** (no base branch to merge back into).
3. `.claude/worktrees/.gitignore` containing `*` is written first — it hides every worktree from the parent repo's status, ignores itself, works in every clone, and never touches the project's own `.gitignore`.
4. `git worktree add -b ide/sess-<id8> <dir> <base>`.
5. **Seed the copy.** `worktree add` materializes every *tracked* file and nothing else, so what makes a project runnable — `node_modules`, `.env`, build output — has to be copied. Roots come from `git status --porcelain=v1 --untracked-files=all --ignored=matching`: the `??` and `!!` rows are exactly untracked + ignored, with no `.gitignore` parsing, and `--ignored=matching` collapses a wholly-ignored directory into one row (so `node_modules` is one entry, not thirty thousand). `.git` and `.claude/worktrees` are never copied.

Any failure past step 4 rolls the whole thing back (`worktree remove --force` + `branch -D` + `prune`) and reports why. It **never falls back to a main-tree session** — a session that quietly isn't isolated is worse than none.

The names are derived from the session id, and the **directory name is permanent**: a live PTY's cwd, any launch-config terminal and every absolute path inside `node_modules` point at it. The **branch** is renamed once (`renameSessionBranch`) when the session earns a title — `ide/sess-9f1c2b3a` becomes `ide/fix-the-parser-2b3a`, keeping an id suffix so identically-titled sessions can't collide, and skipped if that name is taken. A branch rename moves no files; it runs inside `repoWrite` so it can never land between a merge reading the branch name and using it.

## What the UI does with it

- **Toggle** — a two-segment control (Main / Worktree) in the sessions pane header (`#worktree-toggle`), centred next to the SESSIONS label and styled like the git pane's Changes/History tabs one size down. Both states are named because an unlabelled off-position would have to be guessed. Per project, stored in `sharedDataDir/project-settings.json` (not renderer localStorage: main reads it while creating a session, and localStorage is last-instance-wins). Disabled with the reason when the project can't host worktrees.
- **Pre-scan + progress** — heavy copy roots are listed with sizes and checkboxes (unchecked ones are remembered per project), then a pinned progress dialog with a Cancel that reaches the walker through a token. Both use `openDialog`'s `content` / `dismissible` / `onOpen` options rather than hand-rolled chrome.
- **Merge replaces Commit** — see below. Revert is hidden too: both exist to separate one session's hunks from another's in a shared tree, which cannot arise here.
- **Focus-follow** — `selectSession()` calls `focus-session-repo` behind a 150ms trailing debounce, so arrow-keying down a list costs one switch. `setActiveWorktree` is idempotent on top of that.
- **Back to the project** — the `#tree-scope` chip in the explorer header, shown *only* while the panels are on a worktree and naming the session that owns it. Clicking it calls `focus-main-repo` (`setActiveWorktree(null)`). The session stays selected and running — only the tree-derived panels move — and clicking that session again points them back, since `selectSession` re-issues the focus on every click rather than short-circuiting on the active id. Without it, returning to the project tree would mean selecting a main-tree session, which the user should not have to create one for. Clicking the **blank area below the last session row** does the same thing (`#session-list`, `e.target === list` only, so row clicks are untouched) — empty space means "nothing in particular", which here is the project.
- **Marker** — `body.on-worktree` tints the pane headers and underlines the run toolbar; session rows carry a branch glyph. The row of the session whose worktree the panels are showing also gets a `.scoped` highlight (`--list-sel`), set by `setSessionScope()` from `applyRepoChange`. It is separate from `.active` on purpose: the explorer's tree chip returns the panels to the project while that session stays selected, so "selected" and "the tree you are looking at" need two marks. The **window title never changes** on a worktree switch: it names the opened project, and `set-window-title` ignores its argument so no renderer caller can put an opaque `sess-xxxx` directory up there.

## Running the worktree's code

Nothing in the run path needed a worktree branch of its own: `run-configs.js`
reads `.vscode/launch.json`, `tasks.json` and `package.json` from `getRepoPath()`
and resolves `${workspaceFolder}` and `options.cwd` against it, so with a
worktree selected every launch config, task and npm script is discovered in that
tree and spawned there. A worktree that carries its own `.vscode` is honoured
over the project's. `spawnConsole` falls back to `getRepoPath()` too, so a plain
new terminal opens in the selected tree.

What the worktrees *did* change is terminal identity. A config's tab used to be
reused on `kind + name`, so re-running `dev` from a worktree would have restarted
the project's `dev` in place — the opposite of running both at once. Tabs are now
keyed on **`kind + name + owning worktree`** (`c.treeRoot`, the worktree *path*,
because the session gets renamed while its terminal keeps running), and a
worktree tab carries an accent tag naming its session. For the same reason
`runningConfigNames()` and `stopConfig()` filter on `setConsoleScope()` — the
toolbar's play/stop button speaks for the tree in front of the user, and Stop
never reaches into another tree.

Existing terminals keep the cwd they were spawned with; only new ones follow the
active tree. That is what lets a dev server survive clicking through sessions.
`run-config-stop` from a phone stays unscoped — the remote surface has no notion
of a selected tree.

## Merge (`session-merge.js`)

Runs entirely inside `repoWrite` (the same global mutex as the per-session commit and the git pane's commit/amend/undo). Let `W` = worktree, `M` = project, `B` = session branch, `A` = **the branch `M` currently has checked out**.

1. Preflight in `M`: read `A` from its live HEAD (detached is the one refusal -- there is nowhere to land),
   and require no uncommitted tracked changes. The target is deliberately **not** `s.baseBranch`: that field
   records the fork point the session's diff is measured from, while the merge means "land this on the branch
   I am looking at". Cutting a session from `main` and later moving the project to a release branch merges
   into the release branch.
2. Commit everything in `W` (`add -A` + a commit-model message via `sessionCommitMessage`). Plain `add -A` is correct here — `commitBlobs`'s synthesized-tree machinery exists to commit a *subset* of hunks, which a worktree session never needs.
3. If `A` moved on, merge `A` **into `W` first**. This is the deliberate ordering: a conflict surfaces in the session's own isolated tree, where that session's agent can resolve it, and `M` is never left half-merged. On conflict: `merge --abort`, and the renderer offers to hand the conflict to **that session**.
4. `git merge --no-ff` in `M`. After step 3 this cannot conflict. `--no-ff` keeps the session as a visible boundary and makes "was this merged" a plain ancestry question.

Refusals come back as codes (`detached-main`, `dirty-main`, `not-ready`) rather than raw git output, because each has a specific thing the user must do first.

## Change tracking is off

Worktree sessions skip **all** of `trackFsChanges()` — the `s.edits` op log and both git-status baselines. They don't need it: nothing else writes to their checkout, so "what did this session change" is just "what changed in this tree". `session-diff`/`session-diff-stat` answer with `git diff <merge-base>` in the worktree (plus `add -A -N` so newly created files are visible), cached on `s.wtStat` for `baseRow`.

**Hooks stay installed** (`--settings hooksSettings(id)` is untouched): status dots, the session name, the tool line, the token meter, mobile chat and transcripts all still work. Only the attribution — which is also the expensive half, the repeated O(worktree) status scans — is skipped.

## Closing

`close-session` decides the fate of the checkout **before** tearing anything down (once the record is gone, nothing can describe what would be lost). Merged (an ancestor of its fork point *or* of the project's current HEAD, since the merge target follows HEAD) **and** clean → worktree and branch are removed silently. Anything else is reported as `unmerged` with nothing touched, and the user picks: keep the worktree, delete anyway, or cancel. `kill-session` remains the dumb path (remote/back-compat) and just cancels an in-flight copy.

## Everything that walks the project must skip `.claude/worktrees`

Each entry there is a full second checkout of the same repo. Already handled: the explorer tree (`list-dir` hides it by name — search and the fs watcher skip every dot-dir already), `git clean -fdq -e .claude/worktrees`, the seeding copy, **eslint's ignore list** and **`npm test`'s scope** (both would otherwise report every finding once per worktree).

## Known limits

- Two worktrees running the same dev server collide on the port. Not solved; a per-worktree `PORT` offset would be the fix.
- A worktree that outlives its session (kept at close, or orphaned by a crash mid-copy) is pruned from git's registry at project open but its directory is left on disk; there is no in-app list to clean those up yet.
