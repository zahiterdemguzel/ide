# Platform notes (Windows)

Hard-won gotchas. Do not "fix" these back to the obvious-but-broken form.

## node-pty: use the prebuilt fork

Dependency is **`@homebridge/node-pty-prebuilt-multiarch`**, not upstream `node-pty`. Upstream fails to compile on Windows — winpty's gyp step runs `GetCommitHash.bat` from a git submodule that is absent in the npm tarball (`'GetCommitHash.bat' is not recognized`). The fork ships a prebuilt N-API Windows binary, so the Node-ABI prebuild loads fine under Electron. **Do not** add `electron-rebuild` or switch back to `node-pty`.

## PTY needs a full executable path

node-pty on Windows does **not** search `PATH`. Spawning bare `'claude'` throws `Error: File not found`. `resolveClaude()` runs `where claude` once and caches the absolute path. Keep using it.

## Electron BrowserWindow flags

`sandbox: false` is intentional — the preload requires the native node-pty module. Keep `contextIsolation: true` and `nodeIntegration: false`.

## Launching from the VS Code debugger leaks debug env into sessions

When the app is started via `.vscode/launch.json` (VS Code's Node debugger) instead of `npm start`, VS Code injects debugger/inspector variables into our `process.env`: `ELECTRON_RUN_AS_NODE`, `VSCODE_INSPECTOR_OPTIONS`, and a `NODE_OPTIONS=--require <js-debug bootloader>`. Spawning the `claude` CLI (a Node process) with that env makes it boot as a debug-attached target, so **new sessions never open**. `sessionEnv()` in `src/main/sessions.js` strips these before `pty.spawn` — keep that scrub. The launch config also sets `"console": "integratedTerminal"` so the main process actually has a visible console.

## GPU disk-cache errors + multiple instances

On Windows, Chromium spams `Gpu Cache Creation failed: -2` and `Unable to move the cache: Access is denied (0x5)` at startup when the userData cache dir is locked — typically by another app instance fighting over the same dir, or by antivirus. These are non-fatal (the window still opens), but noisy.

The app is meant to run **many instances side by side**, so a single-instance lock is the wrong fix — it was removed. Instead, two mechanisms keep concurrent instances from contending for the cache:

- `disable-gpu-disk-cache` in `src/main/index.js` removes the GPU shader cache (we don't need it).
- `src/main/instance.js` redirects `userData` to a **per-instance profile dir** (`<userData>/instances/<pid>`) before any subsystem reads a path from it, so each instance has its own disposable Chromium cache and singleton lock. The profile is deleted on `quit`. Persistent config (e.g. `last-folder.txt`) stays in the captured `sharedDataDir` so it survives restarts and is common to all instances.

Keep both, and keep `require('./instance')` as the **first** require in `index.js` — it must run before `repo.js` derives its config path from `userData`.

## Network service crash loop

On Windows, Chromium runs its network service in a separate child process, and **all** resource loads (including local `file://` pages) go through it — so it runs even though this app does no networking. Third-party software that injects DLLs into Chromium processes (antivirus, VPN clients, firewall shims, overlay utilities) frequently crashes that process, and Chromium restarts it while logging `Network service crashed, restarting service` on a loop. It's non-fatal but noisy.

Merely unsandboxing the service (`disable-features=NetworkServiceSandbox`) is **not** enough — the separate process is still present and still a target for DLL injection, so it keeps dying. The fix in `src/main/index.js` is `enable-features=NetworkServiceInProcess`, which runs the network service inside the main process: there is no separate child to crash, so the loop disappears. We keep `disable-features=NetworkServiceSandbox` alongside it as a harmless fallback. No security trade-off here since the app makes no network requests. Keep both.

## curl dependency

Hook payloads are delivered with `curl` (ships with Windows 11). If hooks stop firing on a stripped-down machine, confirm `curl` is on PATH.
