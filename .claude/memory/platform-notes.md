# Platform notes (Windows + macOS + Linux)

Hard-won gotchas. Do not "fix" these back to the obvious-but-broken form.

The app runs on all three desktop OSes. Platform-specific code is guarded by `process.platform === 'win32'` with a POSIX (macOS/Linux) fallthrough; native bits use the multiarch node-pty fork and Electron's cross-platform `shell.*` APIs, so no per-OS forking lives in app code. Distributables are built for all three: Windows `portable` `.exe`, macOS `.dmg`, Linux `AppImage` (the `build`/`build:mac`/`build:linux` scripts; CI builds and releases all three — see [testing.md](testing.md)). AppImage is chosen because it runs on any distro without a package manager.

The mobile companion ships separately: `build:android` (`scripts/build-android.mjs`) runs `expo prebuild` on the app in `mobile/` and then a Gradle assemble, leaving the APK at `dist/ide-remote.apk`. It needs a JDK and the Android SDK (`ANDROID_HOME`) locally, so CI does not run it. It defaults to a **fast debug build** (skips R8 minification); pass `--release` (`npm run build:android -- --release`) for a shippable minified APK. Both variants **bundle the JS**: the script patches `debuggableVariants = []` into the generated `app/build.gradle` after every prebuild, because React Native's stock debug variant skips bundling and expects a Metro dev server — installed on a phone it dies with "Unable to load script … index.android.bundle". Don't remove the patch. Gradle is tuned for speed: a pinned `GRADLE_USER_HOME` at `<stage>/.gradle-home` (ASCII path — keeps the daemon + build cache warm across runs and off the non-ASCII repo path) holds a generated `gradle.properties` with a 4 GB heap, `parallel`, and `caching`; the assemble runs with `--build-cache --parallel`.

**The Android build must not run in-tree.** It stages `mobile/` into `%LOCALAPPDATA%\ide-android-build` (ASCII path, outside OneDrive) and builds there, because two things break otherwise and neither has a flag-level fix:

- The Android Gradle Plugin hard-fails on **non-ASCII project paths** (this checkout lives under `Masaüstü`). `android.overridePathCheck=true` only silences the check and pushes the failure down into aapt/the NDK.
- Gradle's temp-workspace moves fail intermittently inside **OneDrive-synced** folders (`Could not move temporary workspace`).

Separately, `settings.gradle` shells out to `node --print` and decodes the output with the JVM's default charset — on a Turkish Windows locale that's `Cp1254`, which mangles UTF-8 paths into `Masa├╝st├╝`. Staging into an ASCII path sidesteps that too.

`node_modules` is **copied** into the staging dir, not symlinked: Node resolves a junction back to its real path and would hand Gradle the non-ASCII source path straight back. The copy (and the prebuild) are re-done only when `package-lock.json` / `app.json` change, so the staging dir keeps Gradle's incremental caches warm. `mobile/app.json` pins `android.package` explicitly — left unset, prebuild derives an app id from the local username.

The per-instance browser-partition link (`instance.js`) uses `fs.symlinkSync(target, link, 'junction')`: the `'junction'` type is honored on Windows and **ignored on macOS/Linux**, where Node creates an ordinary symlink — so the shared, persistent inline-browser profile works identically on every OS.

## macOS: Electron bundle re-signing (postinstall)

On Apple Silicon (and any hardened-runtime macOS), if the `node_modules/electron/dist/Electron.app` bundle's code signature is invalid, macOS **SIGKILLs every helper process** the instant it spawns. The symptom at `npm start` is a crash cascade — `GPU process exited unexpectedly: exit_code=9`, `[renderer gone] killed 9`, `Network service crashed` — and the window never opens. It is not a bug in our code; the OS is refusing to run an improperly-signed binary. A partial `npm install`/rebuild, a file-sync/backup tool, or antivirus can invalidate the signature by touching the bundle (e.g. `code has no resources but signature indicates they must be present`).

`scripts/fix-electron-signature.js` runs as the `postinstall` npm hook: on macOS only, it verifies the bundle signature and, if invalid, ad-hoc re-signs it (`codesign --force --deep --sign -`). It is a no-op off macOS and a no-op when the signature is already valid, so it's safe on every platform and every install. Keep it wired to `postinstall`. If the app ever dies with `killed 9` between installs, re-running `npm run postinstall` (or the `codesign` line the script prints) repairs it.

## node-pty: use the prebuilt fork

Dependency is **`@homebridge/node-pty-prebuilt-multiarch`**, not upstream `node-pty`. Upstream fails to compile on Windows — winpty's gyp step runs `GetCommitHash.bat` from a git submodule that is absent in the npm tarball (`'GetCommitHash.bat' is not recognized`). The fork ships a prebuilt N-API Windows binary, so the Node-ABI prebuild loads fine under Electron. **Do not** add `electron-rebuild` or switch back to `node-pty`.

## PTY needs a full executable path

node-pty on Windows does **not** search `PATH`. Spawning bare `'claude'` throws `Error: File not found`. `resolveClaude()` runs `where claude` once and caches the absolute path. Keep using it.

## Electron BrowserWindow flags

`sandbox: false` is intentional — the preload requires the native node-pty module. Keep `contextIsolation: true` and `nodeIntegration: false`.

## Launching from the VS Code debugger leaks debug env into sessions

When the app is started via `.vscode/launch.json` (VS Code's Node debugger) instead of `npm start`, VS Code injects debugger/inspector variables into our `process.env`: `ELECTRON_RUN_AS_NODE`, `VSCODE_INSPECTOR_OPTIONS`, and a `NODE_OPTIONS=--require <js-debug bootloader> --inspect-publish-uid=http`. Spawning the `claude` CLI (a Node process) with that env makes it boot as a debug-attached target, so **new sessions never open** — and the [setup gate](architecture.md#claude-code-setup-gate)'s install terminal fails the same way, because the installer runs `claude install` (also Node): the install dies in our terminal yet succeeds in a clean Terminal.app. The scrub lives in `cleanEnv()` (`src/main/proc-env.js`, pure + unit-tested) and is applied to **every** `pty.spawn` — both `sessions.js` (`sessionEnv()` delegates to it) and the console PTYs in `consoles.js`. Keep it on both paths.

The `--inspect` scrub must match **every** `--inspect*` variant, not just `--inspect-brk`/`--inspect-port`. js-debug uses `--inspect-publish-uid=http`; a regex that only knows the two common suffixes strips the `--inspect` prefix and leaves `-publish-uid=http` orphaned in `NODE_OPTIONS`. That junk then rides into any Node child the CLI spawns — notably `code.cmd` during the VS Code extension install — which rejects it with `-publish-uid=http is not allowed in NODE_OPTIONS` and aborts. Hence the broad `--inspect[\w-]*(=\S*)?` pattern; keep it broad.

The launch config also sets `"console": "integratedTerminal"` so the main process actually has a visible console.

## GPU disk-cache errors + multiple instances

On Windows, Chromium spams `Gpu Cache Creation failed: -2` and `Unable to move the cache: Access is denied (0x5)` at startup when the userData cache dir is locked — typically by another app instance fighting over the same dir, or by antivirus. These are non-fatal (the window still opens), but noisy.

The app is meant to run **many instances side by side**, so a single-instance lock is the wrong fix — it was removed. Instead, two mechanisms keep concurrent instances from contending for the cache:

- `disable-gpu-shader-disk-cache` in `src/main/index.js` removes the GPU shader cache (we don't need it). The exact name matters: Chromium silently ignores unknown switches, and the earlier `disable-gpu-disk-cache` was **not a real switch** (a no-op), so the cache stayed on and the `Gpu Cache Creation failed` / `Unable to move the cache` errors kept firing until the name was corrected.
- `src/main/instance.js` redirects `userData` to a **per-instance profile dir** (`<userData>/instances/<pid>`) before any subsystem reads a path from it, so each instance has its own disposable Chromium cache and singleton lock. The profile is deleted on `quit`. Persistent config (e.g. `recent-folders.json`) stays in the captured `sharedDataDir` so it survives restarts and is common to all instances.

Two pieces of state live *inside* the disposable profile by default but must survive it: the inline browser's login cookies, and the renderer's `localStorage` settings (theme, locale, panels, agent-model defaults — see [settings.md](settings.md)) — Chromium backs the latter with a `Local Storage` LevelDB folder directly under `userData`. They persist by **different mechanisms** (`instance.js`):

- **Browser partition (`Partitions/browser`)** — junctioned to a shared `<sharedDataDir>/browser-profile` dir. The quit handler removes the junction (`rmdirSync`, which only deletes the reparse point) **before** the recursive delete of the per-instance dir, so the shared target is never swept up.
- **`Local Storage`** — **copied, not junctioned**: the shared `<sharedDataDir>/local-storage` snapshot is `cpSync`ed into the per-instance profile at launch (before Chromium opens it) and copied back on quit (staged via a `.tmp` dir + rename so a mid-copy failure can't half-write the snapshot — a LevelDB folder mixing generations reads as corrupt). It *was* a junction, but LevelDB allows one live process: with a sibling instance running, a new instance's first `localStorage` read blocked ~5.5s waiting on the shared database's lock — and since that read happens during renderer module evaluation, every extra instance opened to 5.5s of blank window. **Do not revert to a junction.** Trade-offs: last instance to quit wins (same as the junction), and settings changed in a session that crashes are lost (quit never fires).

Keep both, and keep `require('./instance')` as the **first** require in `index.js` — it must run before `repo.js` derives its config path from `userData`.

### PID reuse → stale-cache collisions

The `quit` cleanup can't fire on a crash or kill, and even on a clean quit `rmSync` fails on a cache file something still holds — so `instances/<pid>` dirs **pile up**. Windows reuses pids, so a new instance eventually gets a pid whose stale dir is still on disk; Chromium finds an old, version-mismatched cache there and tries to move it aside to recreate it, which fails with `Unable to move the cache: Access is denied` when anything still holds a handle. This is most likely when the app is **launched from inside the app** (the parent has just churned through many pids spawning PTYs and the `claude` CLI, so a fresh Electron pid is far more likely to land on a leftover dir).

`instance.js` defends in two best-effort steps **before** the `setPath` redirect: (1) delete our own pid's leftover dir so we always start from a clean cache (its creator is dead — we hold its pid now), and (2) sweep every other leftover dir whose pid no longer belongs to a running process (`process.kill(pid, 0)` liveness probe; `EPERM` counts as alive). A dir owned by a live sibling instance has an alive pid, so it's skipped — the sweep never disturbs a running instance; a pid reused by an unrelated process also reads as alive, so that dir is left for the next run rather than risk a false delete. The numeric-pid-filter + liveness decision is the pure, unit-tested `staleInstanceDirs` in `instance-lib.js`.

`disable-gpu-shader-disk-cache` is unrelated to the GPU *acceleration* switches below — it disables a flaky on-disk cache, not GPU rendering itself. Keep it.

## GPU acceleration switches

`src/main/index.js` enables `enable-gpu-rasterization` and `enable-zero-copy` so Chromium rasterizes web content on the GPU and skips the CPU→GPU tile copy — smoother panel scrolling and terminal compositing. These are deliberately **moderate**: we do **not** pass `ignore-gpu-blocklist`, so a machine whose GPU/driver Chromium has blocklisted falls back to software rendering rather than risking the instability that forcing past the blocklist can cause (this box has a history of GPU-cache trouble — see above). The terminals' own GPU rendering (WebGL/Canvas xterm addons) is a separate, renderer-side concern — see [architecture.md](architecture.md#renderer) "GPU terminal rendering". Don't add `ignore-gpu-blocklist` without a clear reason.

### Inline browser stays logged in across restarts

The disposable per-instance profile would also wipe the inline browser's `persist:browser` partition (its cookies / localStorage) on every quit — so the user gets logged out of every site each launch. `instance.js` carves out *just that one partition*: it junctions `<instanceDir>/Partitions/browser` to a shared, persistent `<sharedDataDir>/browser-profile` dir before Chromium first touches it, so the browser profile lives in the shared dir and survives. The `quit` cleanup `rmdir`s the junction **before** the recursive delete of `instanceDir` — a recursive delete that followed the junction into the shared profile would wipe the very logins it protects. The rest of the profile (cache, default session) stays per-instance and disposable. Trade-off: concurrent instances share this one partition's storage (rarely an issue, since the inline browser is seldom driven from two windows at once). The ⋮ menu's "Reset cookies" still clears it via `clearStorageData` on the `persist:browser` partition.

## Network service crash loop

On Windows, Chromium runs its network service in a separate child process, and **all** resource loads (including local `file://` pages) go through it — so it runs even though this app does no networking. Third-party software that injects DLLs into Chromium processes (antivirus, VPN clients, firewall shims, overlay utilities) frequently crashes that process, and Chromium restarts it while logging `Network service crashed, restarting service` on a loop. It's non-fatal but noisy.

Merely unsandboxing the service (`disable-features=NetworkServiceSandbox`) is **not** enough — the separate process is still present and still a target for DLL injection, so it keeps dying. The fix in `src/main/index.js` is `enable-features=NetworkServiceInProcess`, which runs the network service inside the main process: there is no separate child to crash, so the loop disappears. We keep `disable-features=NetworkServiceSandbox` alongside it as a harmless fallback. No security trade-off here since the app makes no network requests. Keep both.

## Windows target is NSIS, not portable — startup time

The Windows build target is **`nsis`** (an assisted installer — classic wizard with
a welcome page, install-directory selection, and a "run now" checkbox on finish),
**not** `portable`.
The `portable` target produces a single `.exe` that, on every launch,
**self-extracts the entire ~70 MB bundle (Electron + `node_modules`) to a throwaway
`%TEMP%\<guid>` dir, runs from there, and deletes it on exit** — so every cold start
pays a full decompress + disk-write (and an antivirus scan of the freshly-extracted
files) *before the window opens*. That made launch noticeably slow. NSIS extracts
**once** at install time and then launches the installed files directly, so startup
is near-instant. Don't switch back to `portable` without accepting that cost.

`crashDir()` in `src/main/crashlog.js` still prefers the `PORTABLE_EXECUTABLE_DIR`
env var (set only by the portable target) so it keeps working if anyone ever rebuilds
portable; for the NSIS build that var is unset and it falls back to next-to-exe (the
install dir, which is writable and persistent), then the project root (dev). Keep the
fallback chain.

Note: node-pty itself works fine in a packaged build — electron-builder's
smart-unpack pulls the whole `@homebridge/node-pty-prebuilt-multiarch` module
(`pty.node`, `conpty/OpenConsole.exe`, `winpty-agent.exe`, the conout worker, …)
out of `app.asar` into `app.asar.unpacked`, and node-pty's `__dirname` already
resolves there, so launch configs / tasks run in the packaged build the same as
under `npm start`.

## curl dependency

Hook payloads are delivered with `curl` (ships with Windows 11). If hooks stop firing on a stripped-down machine, confirm `curl` is on PATH.
