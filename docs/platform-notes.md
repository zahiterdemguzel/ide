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

## GPU disk-cache errors + single instance

On Windows, Chromium spams `Gpu Cache Creation failed: -2` and `Unable to move the cache: Access is denied (0x5)` at startup when the userData cache dir is locked — typically by a second app instance fighting over the same dir, or by antivirus. These are non-fatal (the window still opens), but noisy. `src/main/index.js` handles both: `disable-gpu-disk-cache` removes the GPU shader cache (we don't need it), and `requestSingleInstanceLock()` makes a second launch focus the existing window instead of spawning a rival process that contends for the cache. Keep both.

## Network service crash loop

On Windows, Chromium runs its network service in a separate sandboxed child process, and **all** resource loads (including local `file://` pages) go through it — so it runs even though this app does no networking. Third-party software that injects DLLs into Chromium processes (antivirus, VPN clients, firewall shims, overlay utilities) frequently crashes that sandboxed process, and Chromium restarts it while logging `Network service crashed, restarting service` on a loop. It's non-fatal but noisy.

`disable-features=NetworkServiceSandbox` in `src/main/index.js` stops the crash loop by running the network service unsandboxed, so the injected DLLs no longer kill it. No security trade-off here since the app makes no network requests. Keep it.

## curl dependency

Hook payloads are delivered with `curl` (ships with Windows 11). If hooks stop firing on a stripped-down machine, confirm `curl` is on PATH.
