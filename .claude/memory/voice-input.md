# Voice input (dictate into the focused session)

**While a session terminal has keyboard focus, the microphone is live and what the
user says is typed into that session.** No hotkey, no button — the mic follows the
caret. The rule is exactly *"could I type into this panel right now?"*, so the same
act that makes a session ready for the keyboard makes it ready for the voice.
Recognition is fully offline: a bundled Whisper model runs in the main process, so
nothing is ever uploaded.

> **The mouse is irrelevant.** An earlier version armed on *hover*, which is worse on
> both counts: moving the cursor across the app could open a microphone, and it
> needed a dwell delay, a pointer-position cache and `pointermove` bookkeeping to
> approximate intent that focus states already express exactly.
> `test/voice-focus.test.js` fails if a pointer listener creeps back in.

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
4. **Interaction** — `src/renderer/voice.js`: focus tracking, the guards, the
   indicator, and writing text into the session's PTY via the existing `sendInput`.
   Owns its own settings row, storage and IPC (same shape as `custom-models.js`);
   `settings.js` only calls `initVoice()` and `refreshVoiceSection()`.

## How arming is decided

Everything routes through one `syncToFocus()` — a focus change, the window regaining
focus, the feature being switched on — so there is a single definition of "should
this be listening": **voice enabled, window focused, and the caret inside a live
`.term-container`**.

- Bound to **`focusin` + `focusout`** (they bubble; `focus`/`blur` don't).
  `focusout` is deferred a tick so `document.activeElement` has settled, and it's
  needed for the case where focus leaves for something that never takes focus itself
  (clicking blank chrome), where no `focusin` follows.
- xterm focuses a **hidden textarea inside** the pane, so the caret is always on a
  *descendant* of `.term-container`, never the container itself — hence `closest()`.
- A **suspended** pane never arms: no live PTY behind it, which is the same reason it
  can't be typed into by hand.
- A **modal dialog traps focus**, so nothing arms while the settings or setup dialog
  is open. That falls out of the rule rather than being special-cased, and it's
  correct — the terminal can't be typed into then either.
- `selectSession()` already calls `term.focus()`, so picking a session in the sidebar
  arms it without the user clicking into the pane.

Two guards remain non-negotiable, because a mic that opens without a button press is
still a mic that opens on its own:

- **`document.hasFocus()`** — a focused terminal in an *unfocused window* is inert
  (the user is talking to another app), and a window `blur` disarms immediately.
- **A visible indicator** — the pulsing `.voice-hot` pill (`layout.css`) plus a ring
  on the session that is listening.

A **120 ms settle** sits in front of arming, because a click that moves focus between
panes can flicker for a frame. It is *not* the old dwell delay: it guards against
transient focus, not against accidental proximity.

The mic stream is opened once and **kept open between sessions, with the worklet
gated** rather than torn down: `getUserMedia` costs 200–500 ms, which would eat the
first words of a phrase. It's released after 3 minutes idle, so the OS recording
indicator doesn't stay lit after the user has moved on.

`.term-container` carries **`data-session-id`** — that's how the focused element maps
to a session. A phrase is always typed into the session it was *captured* for, even
if the cursor has since moved.

> **All terminal panes are built by `sessions.js`'s `createTermContainer(id)`** —
> deliberately the only site, because the pane must carry `data-session-id`. There
> used to be two (`buildTerminal` for a fresh session, `restoreSessionRow` for one
> restored from disk) and only the first stamped the attribute, which shipped a
> feature that did **nothing at all, silently**, for every restored session — i.e.
> most sessions after a restart — because `sessionOf()` resolved `null` and it
> never armed. `test/voice-focus.test.js` holds the line by asserting there is still
> exactly **one** creation site (and that `voice.js` still reads the attribute the
> writer sets); with one site the invariant is structural rather than policed.

## The indicator (three states)

The pill is painted **before** arming starts, not when recognition is ready: a cold
first arm pays mic acquisition plus a model load, and each phrase costs ~1 s to
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
that never pauses. Losing focus mid-phrase **flushes** rather than discards — the user
lost focus, but they still said the words. True word-by-word streaming would
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
user switches the feature on, not inside the first arm where the delay would swallow
their opening words. At startup (feature already on) the warm is deferred to
`requestIdleCallback` — pulling in a native module and ~1 GB of weights competes with
exactly the window where sessions and terminals are being restored. Warming deliberately does
*not* touch the microphone — that would light the OS recording indicator while the
no session is even focused.

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

`decodingMethod` is `greedy_search`, and `task` is always `'transcribe'` — never
`'translate'`, so the user gets back what they actually said.

## Spoken language (measured, not assumed)

`LANGUAGES` in stt-lib offers **Auto-detect / English / Turkish**, defaulting to
**English**. The language is a *load-time* property of the recognizer, so it's part
of the cache key (`<modelId>:<languageId>`) and switching it reloads, exactly like
switching model. An English-only model ignores the setting and is pinned to `en`.

Measured with Turkish speech (Piper `tr_TR` TTS, six dictation sentences, decoded
three ways):

- **Turkish quality is good.** All six came back correct, differing only in
  punctuation. Turbo being weak in Turkish was *not* the problem.
- **`auto` and `tr` produced identical output on every sentence** — auto-detect was
  not misfiring on clean audio. Auto is still the riskier default in principle
  (detection runs per segment and segments are often under a second), which is why
  the default is a pinned language, but don't claim auto is broken.
- **A wrong pin is catastrophic**, which is the real argument for the setting:
  Turkish forced through `en` came back as invented English ("Bu dosyayı açar mısın"
  → "This document will be opened by the"). Whisper *will* confabulate rather than
  admit the language is wrong.

**Tail padding.** The same test found Whisper drops the final syllable of a clip
whose audio stops on the last phoneme ("kaydet" → "kay", "oluştur" → "oluş"); the
identical clip with trailing silence transcribed perfectly. Every segment therefore
gets `TAIL_PADDING_SECONDS` (0.4 s) of zeros before decoding — free, since Whisper
pads to a 30-second window regardless. On *real* VAD segments the effect is mostly
cosmetic (the VAD already carries some trailing context: 9 of 16 segments changed,
nearly all punctuation, one recovered a dropped word, none got worse) — so keep it as
cheap insurance, but don't expect it to transform real dictation.

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
2. **The trigger itself was wrong (historical).** While it was hover-driven,
   `pointerover` alone never armed a cursor that was *already* resting over the
   terminal — the normal flow after closing the Settings dialog — because it fires
   only when the cursor enters a *new* element. That was patched with `pointermove`
   plus an `elementFromPoint` re-read, and then removed entirely when the trigger
   moved to keyboard focus, where "is this session ready for input" is a state to
   read rather than an intent to infer.
3. **`data-session-id` on both container paths** — see the note above.
4. **`ensureRecognizer` needed in-flight dedupe.** `stt-warm` (on enable) and
   `stt-start` (first arm) both asked for the recognizer, each loading ~1 GB of
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
