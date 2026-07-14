# Remote access (mobile companion)

Developers can drive the IDE from a phone: QR pairing, project switching, Claude sessions, git, file editing, terminals, and dev-server port forwarding. Three parts: the Electron-free `server/` socket bridge, thin glue in `src/main/remote*.js`, and the Expo app in `mobile/`. Design rule (user requirement): **the backend only bridges sockets/communications** — all IDE logic and auth verification live in the desktop app; `server/` never inspects business payloads.

## server/ — the socket bridge (plain Node, CommonJS, linted like src/main)

- `protocol.js` — pure: message parse/validate, `REMOTE_CHANNELS` **allowlist** (`req` mirrors `ipcMain.handle`, `send` mirrors `ipcMain.on`), `REMOTE_EVENTS` (renderer pushes forwarded to phones), `fwd-open`/`fwd-close` shapes. To expose a channel remotely you must add it here — an existing handler is not enough. Excluded on purpose: `open-folder` (native dialog), clipboard, `db-*`, runners, assets.
- `auth-lib.js` — pure: single-use 5-min pairing tokens (3 wrong guesses invalidates), device credentials (32-byte tokens, only sha256 hashes persisted), injected-store CRUD.
- `ws-server.js` — `startRemoteServer({invoke, deviceStore, forward, ...})` on `0.0.0.0:<ephemeral>` (`ws` dep); hello → pair/auth → ready state machine; 15s heartbeat; routes `fwd-open/close` to the injected `forward` hook (absent → `forwarding-disabled`).
- `http-proxy.js` + `http-proxy-lib.js` — dev-server port forwarding: one LAN listener per forwarded port piping to `127.0.0.1:<target>`; auth = one-time `?_ideauth=` URL token → 302 that sets an HttpOnly cookie (pure decisions in the lib); raw-socket Upgrade passthrough keeps Vite/webpack HMR websockets working.
- `relay.js` + `index.js` + its own `package.json` — standalone cloud relay (deploy: root dir `server`, build `npm install`, start `node index.js`, listens on `process.env.PORT`). Pure frame forwarding between one desktop socket and N mobile sockets per room using `{c:<clientId>, d:<frame>}` envelopes; never parses `d`. The desktop-side relay client (connecting out to a relay) is **not wired yet**.

## Desktop glue (src/main)

- `remote-bridge.js` — subsystems register via its `handle`/`on` (aliased `bridge.handle`/`bridge.on`) instead of `ipcMain`; registers with both Electron and a registry. Remote calls invoke the same fn with a stub event `{sender:null, remote:true, deviceId}`. Bridged: `repo.js`, `sessions.js`, `git.js`, `explorer.js`, `consoles.js`, `session-commit.js`. Kept on raw `ipcMain`: `db.js`, `runners.js`, `run-configs.js`, `onboarding-store.js`, `window.js`, `remote.js` itself.
- `remote.js` — desktop control (never remote-callable): enable/disable the embedded server, `ide://pair?v=1&host=…&port=…&tk=…` QR payloads (prefers private-range IPv4), device store in `remote-devices.json` under `sharedDataDir`, forwards `sendToRenderer` pushes via the `onBroadcast` seam in `window.js`, owns the port-forward proxy map (proxies die on disable/quit).
- A remote `open-folder-path` also pushes `folder-changed` so the desktop UI follows the switch (repo path is global — remote switch switches the desktop too, by design).
- UI: **Settings dialog → "Remote access" group** (`src/renderer/remote-pane.js`): enable toggle, QR (`qrcode-generator` ESM via import map), paired-device list with revoke. It refreshes on the settings-btn click (additive `addEventListener`, since settings.js owns `.onclick`).

## mobile/ — Expo app (TypeScript, own package; NOT in electron-builder files)

`src/api/connection.ts` (ws client: req/res correlation, reconnect+backoff, ev emitter, `forwardPort()`), `src/api/pairing.ts` (QR parse + SecureStore). Screens: Pair (expo-camera scan), Projects (recent list + hub), Sessions, Terminal (xterm.js in a WebView via CDN, base64-injected `pty-data`), Git, Files (list/read/write + plain editor), Ports (fwd-open → `Linking.openURL`). See `mobile/README.md`.

## Gotchas

- Connection is plain `ws://` — UI copy says trusted-network only. `wss://` + cert pinning in the QR is the known fast-follow.
- Revoking a device does not terminate its already-open socket; it only blocks the next auth.
- Tests: `test/remote-{protocol,auth-lib,ws-server,relay,http-proxy}.test.js` — real ws clients/http servers in-process, no Electron. Locale parity test requires every `remote.*` string in all 5 locales.
- **Never bulk-rewrite locale files (or any non-ASCII file) with PowerShell Get-Content/Set-Content** — PS 5.1 reads ANSI by default and mojibakes UTF-8; it also BOM-stamps. Use the Edit tool.
