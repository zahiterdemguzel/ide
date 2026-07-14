# IDE Remote (mobile companion)

Expo app that pairs with the desktop IDE and drives it remotely: switch recent
projects, run Claude sessions in a live terminal, stage/commit/push in git,
browse and edit files, and open desktop dev servers in the phone's browser
(port forwarding).

## Run it

```sh
cd mobile
npm install
npx expo start        # then open in Expo Go on the phone
```

Phone and desktop must be on the same network. On the desktop: Settings →
Remote access → enable, then scan the QR code from the Pair screen. The device
credential is stored in SecureStore; unpair from the Projects header.

## How it talks to the desktop

`src/api/connection.ts` speaks the JSON ws protocol from the repo's `server/`
package — `req`/`res` mirror the desktop's `ipcMain.handle` channels 1:1,
`send` mirrors `ipcMain.on`, `ev` mirrors renderer pushes. Channels a phone may
call are allowlisted in `server/protocol.js` (desktop side). The terminal
screen hosts xterm.js in a WebView (xterm can't run in React Native) and
streams `pty-data`/`pty-input` exactly like the desktop renderer.

Port forwarding: the Ports screen sends `fwd-open` with a port number; the
desktop starts a LAN reverse proxy for `127.0.0.1:<port>` and returns a
one-time-auth URL that is opened in the system browser.
