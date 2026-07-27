# Voice input (dictate on hover)

**While the mouse cursor rests over a session terminal, the microphone is live and
what the user says is typed into that session.** No hotkey, no button — cursor
position *is* the control. Recognition is fully offline: a bundled Whisper model
runs in the main process, so nothing is ever uploaded.

Text is **typed into the session, never submitted**. The user reviews it and presses
Enter themselves.

## The parts

1. **Pure lib** — `src/main/stt-lib.js`: the model registry, path resolution
   (packaged vs dev), the readiness check (`statSize`/`modelReady`), the runtime
   tuning (`VAD_CONFIG`, `SAMPLE_RATE`, `recognizerThreads()`), and the transcript
   filter. Electron-free, because `scripts/fetch-stt-model.mjs` (an ES module)
   imports the *same* registry and the *same* `statSize` the main process uses — the
   downloader and the engine must never disagree about a filename or about what
   "installed" means. Tested in `test/stt-lib.test.js`.
2. **Engine + IPC** — `src/main/stt.js`, a thin shell over
   [`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node) (npm dep with
   prebuilt binaries per platform; no compiler, `npmRebuild` stays false). Holds an
   LRU-of-1 `OfflineRecognizer` plus a Silero `Vad`. Channels: `stt-status`,
   `stt-warm`, `stt-start`, `stt-audio`, `stt-stop`, `stt-release`; pushes `stt-text`,
   `stt-busy` and `stt-error`. Decodes run one at a time (the addon is not reentrant)
   through `createLimiter(1)` from `concurrency.js`, so a failed decode settles on its
   own promise instead of poisoning the queue for the rest of the session.
3. **Capture** — `src/renderer/audio/pcm-worklet.js`, an `AudioWorkletProcessor`
   that batches mono Float32 frames to 1024 samples (~64 ms) before posting them.
   It's a **real file, not a blob URL**, because the renderer's CSP is
   `script-src 'self'` and a blob-backed worklet is blocked.
4. **Interaction** — `src/renderer/voice.js`: hover tracking, the guards, the
   indicator, and writing text into the session's PTY via the existing `sendInput`.
   Owns its own settings row, storage and IPC (same shape as `custom-models.js`);
   `settings.js` only calls `initVoice()` and `refreshVoiceSection()`.

## The three guards (don't remove these)

A microphone that opens from cursor position alone is a privacy surface, so:

- **300 ms dwell** before arming — crossing a terminal to reach the git pane must
  not start listening.
- **`document.hasFocus()`** — hovering while another app is focused is inert, and a
  window `blur` disarms immediately.
- **A visible indicator** — the pulsing `.voice-hot` pill (`layout.css`) sits in the
  corner of the terminal that is listening.

The mic stream is opened once and **kept open between hovers, with the worklet
gated** rather than torn down: `getUserMedia` costs 200–500 ms, which would eat the
first words of a phrase. It's released after 3 minutes idle, so the OS recording
indicator doesn't stay lit after the user has moved on.

`.term-container` carries **`data-session-id`** — that's how the hovered element maps
to a session. A phrase is always typed into the session it was *captured* for, even
if the cursor has since moved.

> **All terminal panes are built by `sessions.js`'s `createTermContainer(id)`** —
> deliberately the only site, because the pane must carry `data-session-id`. There
> used to be two (`buildTerminal` for a fresh session, `restoreSessionRow` for one
> restored from disk) and only the first stamped the attribute, which shipped a
> feature that did **nothing at all, silently**, for every restored session — i.e.
> most sessions after a restart — because `sessionUnder()` resolved `null` and hover
> never armed. `test/voice-hover.test.js` holds the line by asserting there is still
> exactly **one** creation site (and that `voice.js` still reads the attribute the
> writer sets); with one site the invariant is structural rather than policed.

## The indicator (three states)

The pill is painted **before** arming starts, not when recognition is ready: a cold
first hover pays mic acquisition plus a model load, and each phrase costs ~1 s to
decode — silence through either reads as "the feature is broken".

| state | means | look |
|---|---|---|
| `starting` | arming: acquiring the mic / loading weights | dim dot, breathing |
| `listening` | mic live, waiting for speech | red dot, pulsing |
| `transcribing` | a finished phrase is being decoded | steady accent dot |

`transcribing` is driven by **`stt-busy`** (`{sessionId, busy}`), pushed from main
around each decode batch. The listening terminal also gets an inset ring
(`.term-container.voice-listening`, `layout.css`). `disarm()` clears the pill even
when arming never completed — a leftover "starting" pill would claim the mic is live
when it isn't.

## Why phrase-at-a-pause, not word-by-word

Whisper is not a streaming model, so text can't appear word by word. Silero VAD cuts
the stream on natural pauses (`minSilenceDuration: 0.35`, tuned for a fast talker)
and each segment is decoded whole; `maxSpeechDuration: 12` force-cuts a monologue
that never pauses. Leaving mid-phrase **flushes** rather than discards — the user
stopped hovering, but they still said the words. True word-by-word streaming would
need a transducer (Parakeet), i.e. a second model format and decode path.

## Latency: thread count is the only lever

Whisper always encodes a **padded 30-second window**, so a phrase costs about the
same to decode however short it is. Measured on turbo int8:

| threads | 2 | 4 | 8 | 12 | 16 |
|---|---|---|---|---|---|
| decode | 3.2 s | 2.7 s | 1.6 s | 1.1 s | 1.1 s |

So `recognizerThreads(cpus)` = `clamp(cpus - 2, 2, 12)` (pure + tested in stt-lib) —
it plateaus past 12, and two cores are left for the IDE itself. On a weak CPU a long
uninterrupted monologue can decode slower than it's spoken; the backlog drains on the
next pause.

Model load is ~2.7 s, which is why **`stt-warm` exists**: the weights load when the
user switches the feature on, not inside the first hover where the delay would swallow
their opening words. At startup (feature already on) the warm is deferred to
`requestIdleCallback` — pulling in a native module and ~1 GB of weights competes with
exactly the window where sessions and terminals are being restored. Warming deliberately does
*not* touch the microphone — that would light the OS recording indicator while the
user isn't even hovering a terminal.

## Hallucination filter

Whisper was trained on subtitles, so a VAD segment that caught only a keystroke or a
breath comes back as a caption artifact ("Thank you.", "Subtitles by the Amara.org
community"). `shouldEmit()` drops a segment whose *entire* content is one of those,
and `normalizeTranscript()` strips bracketed sound events (`[BLANK_AUDIO]`,
`(music)`). Both are pure + tested, and filtering happens **in main**, so an artifact
never crosses the IPC boundary. A phrase that merely *contains* a stock word
("thank you for the review, now fix it") is kept.

## The model, and the 1 GB budget

**Whisper large-v3-turbo, int8** — one model, 990 MB extracted, English + Turkish
(and 97 other languages) with automatic detection, so code-switching mid-sentence
works. It is the highest-quality Whisper that fits the 1 GB budget for bundled
weights: `large-v3` int8 is ~1.5 GB, and fp16 turbo ~1.6 GB.

**Only one model ships**, which is why the Voice model dropdown has a single row. A
second one would have to fit in the remaining ~35 MB and none does (even `tiny.en` is
~50 MB). Everything downstream is already plural — adding a model later is one entry
in `MODELS` plus the fetch. `test/stt-lib.test.js` asserts the budget so a future
entry can't silently blow it.

`decodingMethod` is `greedy_search`; the multilingual model gets `language: ''` so it
detects the language itself (an English-only model is pinned to `en`, because letting
one of those guess produces garbage).

## Install & build

The weights are **not committed** (`vendor/` is gitignored). `scripts/fetch-stt-model.mjs`
runs from **`postinstall`** and downloads them once per machine:

- Idempotent — an already-present, non-empty model is skipped, so repeat installs cost
  nothing.
- **Resumable** via HTTP Range, writing to `.part` and renaming only after the size
  matches the release asset's published byte count. An interrupted run can never leave
  a truncated file that later looks valid. (The release exposes no checksum, so exact
  size + successful bzip2 extraction is the integrity gate.)
- Extraction shells out to the platform **`tar`** — bzip2 isn't in Node's zlib, and
  bsdtar on Windows 10+ and macOS both auto-detect the compression.
- Normalizes the archive's per-model filenames (`turbo-encoder.int8.onnx`, …) to fixed
  `encoder.int8.onnx` / `decoder.int8.onnx` / `tokens.txt`, and **discards the fp32
  weights** the archive also carries. The engine then needs no per-model filename
  knowledge.
- **Non-fatal on failure**: a flaky network must not break `npm install` for the whole
  IDE over one optional feature. It warns, `stt-status` reports the models as missing,
  the Settings toggle stays disabled with that hint, and `npm run fetch:stt` retries.
  `SKIP_STT_MODEL=1` skips it entirely (CI jobs that only lint/test).

electron-builder ships `vendor/stt` → `<resources>/stt` via `extraResources`, so
`modelsRoot()` branches on `app.isPackaged` — **this only shows up in a built
artifact**, never in dev. The native addon is `asarUnpack`'d
(`node_modules/sherpa-onnx-node/**`, `node_modules/sherpa-onnx-*/**`); it can't load
from inside an asar. The platform binary package is an optional dep resolved per
build host — a Windows build machine gets `sherpa-onnx-win-x64`, a mac one the darwin
package, so **each platform's installer must be built on (or cross-installed for)
that platform**.

**macOS needs the microphone entitlement**: `build/entitlements.mac.plist` carries
`com.apple.security.device.audio-input` and `mac.extendInfo` carries
`NSMicrophoneUsageDescription`. Without them a signed build's `getUserMedia` resolves
but delivers **silence, with no error to catch** — the single most common way this
feature breaks.

## Four ways this broke (all fixed — don't reintroduce)

Every one of these left the feature looking *healthy* while doing nothing, which is
why they're listed rather than just fixed:

1. **`vad.front()` must be `vad.front(false)`.** sherpa-onnx defaults to returning an
   **external** ArrayBuffer wrapping its own memory. Plain Node accepts that;
   **Electron rejects it** — "External buffers are not allowed" (V8 sandbox / pointer
   compression) — so popping a speech segment throws and *every phrase is lost*,
   after the model, the mic and the VAD all report fine. Same argument exists on
   `CircularBuffer.get()` and `readWave()`. **A Node-only test cannot catch this**;
   it only appears under Electron.
2. **`pointerover` alone never armed a resting cursor.** It fires only when the
   cursor *enters a new element*. The normal flow — switch voice input on in the
   Settings dialog, close it with the mouse already over the terminal — produces no
   further `pointerover`, so nothing happened until the user left the pane and came
   back. Fixed by also listening to **`pointermove`** (cheap: `hoverTo()` early-outs
   unless the resolved session changed) and by `reevaluateHover()` — an
   `elementFromPoint` re-read — on enable and on window focus.
3. **`data-session-id` on both container paths** — see the note above.
4. **`ensureRecognizer` needed in-flight dedupe.** `stt-warm` (on enable) and
   `stt-start` (first hover) both asked for the recognizer, each loading ~1 GB of
   weights concurrently: double the memory, slower than either alone, and the
   indicator sat on "Starting…". The pending promise is now shared.

Also: a failure inside the `stt-audio` handler is now reported to the renderer
**once** (`audioErrorReported`), not just logged. Audio arrives ~16×/second, so
reporting every failure would spam a dialog per chunk — but reporting none is exactly
how a dead pipeline masquerades as "the indicator is on and nothing happens".

## Environment facts (measured, don't re-investigate)

Probed headlessly under Electron 31.7.7 (Node 20.18, ABI 125) on Windows:

- `sherpa-onnx-node` **loads fine under Electron** — it's a Node-API addon, so the
  prebuilt binary is ABI-stable and needs no rebuild (`npmRebuild` stays false).
- The whole chain was verified under Electron by a throwaway probe that loaded the
  real `index.html` + preload, synthesized a `pointermove` over a `.term-container`,
  and fed a real WAV through `window.api.sttAudio()` in 1024-sample chunks — the
  recognizer pushed back correct phrases tagged with the right session id. If this
  breaks again, that shape of probe (plus spying on `window.js`'s `sendToRenderer`
  export *before* `stt.js` destructures it) is the fastest way to find out where.
- The renderer **is a secure context under `file://`**: `window.isSecureContext` is
  true, `navigator.mediaDevices.getUserMedia` exists and resolves with a track, and
  `AudioWorklet.addModule()` loads the worklet **file** fine under the app's
  `script-src 'self'` CSP. (A blob-URL worklet would be blocked — that's why the
  worklet is a real file.) No `setPermissionRequestHandler` is installed, and
  Electron grants by default, so the mic needs no extra wiring on Windows. macOS
  still needs the entitlement below.

## Not exposed to a phone

Voice input is driven by this machine's cursor and microphone, so none of the `stt-*`
channels are in the `server/protocol.js` allowlist. A paired phone can't arm, stop, or
configure it. Console terminals are deliberately excluded too — only
`.term-container` (the panes where the user talks to Claude) arms the mic, not the
build-output consoles.
