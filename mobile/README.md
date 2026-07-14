# IDE Remote (mobile companion)

Expo app that pairs with the desktop IDE and drives it remotely: switch recent
projects, talk to Claude sessions in a chat, stage/commit/push in git, browse and
edit files, and open desktop dev servers in the phone's browser (port forwarding).

## Run it

```sh
cd mobile
npm install
npx expo start        # then open in Expo Go on the phone
```

Phone and desktop must be on the same network. On the desktop: Settings →
Remote access → enable, then scan the QR code from the Pair screen. The device
credential is stored in SecureStore; unpair from the project drawer.

The app's destinations are the bottom tabs (Sessions, Git, Files, Ports), so the
header title is free to show the active project's name instead of the screen's.
Project switching is deliberately *not* a tab: the small square icon button at
header-left opens `src/components/ProjectDrawer.tsx`, a panel that slides in from
the left with the desktop's recent projects (and the Unpair action).

A Claude session opens as a **chat**, not a terminal (`src/screens/ChatScreen.tsx`):
messages, a composer, image attachments, and a `/` command menu. The messages come
from Claude Code's own transcript, which the desktop tails and pushes — the phone
never sees ANSI. A permission prompt, which only exists inside the TUI, is lifted out
by the desktop and arrives as a card with its options as buttons. The one terminal
left is the run console (a dev server's log), which really is a terminal.

The Files tab browses with breadcrumbs, shows files with the **desktop explorer's
own icons**, and opens them **syntax-highlighted** (tap the pencil to edit, Save to
write back). Neither the icons nor the language mapping is maintained twice: both
are generated from the desktop's modules into `src/generated/desktop-assets.ts` by
`npm run gen:mobile` **in the repo root**, and a root test fails if that output
drifts. Don't hand-edit the generated file.

## How it talks to the desktop

`src/api/connection.ts` speaks the JSON ws protocol from the repo's `server/`
package — `req`/`res` mirror the desktop's `ipcMain.handle` channels 1:1,
`send` mirrors `ipcMain.on`, `ev` mirrors renderer pushes. Channels a phone may
call are allowlisted in `server/protocol.js` (desktop side). The chat fetches
`session-transcript`, follows `transcript-data` / `session-ask` pushes, and sends
with `send-prompt`; the run console hosts xterm.js in a WebView (xterm can't run in
React Native) and streams `term-data`/`term-input` like the desktop renderer.

Port forwarding: the Ports screen sends `fwd-open` with a port number; the
desktop starts a LAN reverse proxy for `127.0.0.1:<port>` and returns a
one-time-auth URL that is opened in the system browser.
