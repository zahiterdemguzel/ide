# IDE Remote (mobile companion)

Expo app that pairs with the desktop IDE and drives it remotely: switch recent
projects, talk to Claude sessions in a chat, stage/commit/push in git, browse and
edit files, and browse the web through the **desktop's own browser** — the page
renders in an offscreen window on the desktop and streams to the phone as frames,
with taps, scrolls and typing sent back (the Browser tab).

## Run it

```sh
cd mobile
npm install
npx expo start        # then open in Expo Go on the phone
```

On the desktop: Settings → Remote access → enable, then scan the QR code from the
Pair screen. The phone reaches the desktop over the cloud relay, so a shipped
build works from anywhere; an Expo dev run talks to the relay on your machine, so
for that the phone must be on the same network. The device credential is stored in
SecureStore; unpair from the project drawer.

The app's destinations are the bottom tabs (Sessions, Git, Files, Browser), so the
header title is free to show the active project's name instead of the screen's.
Project switching is deliberately *not* a tab: the small square icon button at
header-left opens `src/components/ProjectDrawer.tsx`, a panel that slides in from
the left with the desktop's recent projects (and the Unpair action).

A Claude session opens as a **chat**, not a terminal (`src/screens/ChatScreen.tsx`):
messages, a composer, image attachments, and a `/` command menu. The messages come
from Claude Code's own transcript, which the desktop tails and pushes — the phone
never sees ANSI. A question the session blocks on — one of Claude's multiple-choice
questions (it can ask several in one go) or a permission prompt — arrives as a card:
tap an option, or write your own answer, so you are never stuck picking from someone
else's list. None of it is scraped from the terminal: the desktop reads the question
off the hook that announces it and replays your answers as the keystrokes the box
expects. The one terminal left is the run console (a dev server's log), which really
is a terminal.

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
`session-transcript`, follows `transcript-data` / `session-ask` pushes, sends with
`send-prompt` and replies to a question with `answer-ask`; the run console hosts
xterm.js in a WebView (xterm can't run in
React Native) and streams `term-data`/`term-input` like the desktop renderer.

Remote browser: the Browser tab asks the desktop to open an offscreen browser
window (`browser-open`), watches `browser-frame` JPEG frames (a subscribed
stream, like a terminal's bytes), and sends normalized input back as
`browser-input` events the desktop injects into the page. The desktop renders;
the phone is a remote control with a picture.

Port forwarding (currently parked behind `SHOW_PORTS_TAB` in `App.tsx` and
`PORT_FORWARDING_ENABLED` in the desktop's `src/main/remote.js` — flip both to
restore): the Ports screen sends `fwd-open` with a port number (and an
optional path); the desktop starts a reverse proxy for `127.0.0.1:<port>` and
returns a one-time-auth URL (through the relay) opened in the system browser. What is
forwarded is the whole site: the token becomes a `Path=/` cookie on first hit,
so from there any path on that origin (`/login`, `/admin`) can just be typed —
onto the base address the screen shows, not onto the opened link, which ends in
the token.
