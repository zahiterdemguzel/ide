// Speech-to-text for voice input: owns the sherpa-onnx offline Whisper recognizer
// and the Silero VAD, and turns a stream of mic samples from the renderer into
// recognized phrases pushed back as `stt-text`.
//
// Why the split: the renderer captures the audio (only it has getUserMedia and the
// cursor state that decides *when* to listen) and decides what to do with the
// text; main does the recognition, because the native addon and the ~770 MB of
// weights belong nowhere near the renderer sandbox. All pure decisions — paths,
// model registry, which transcripts are worth typing — live in stt-lib.js.
//
// Nothing loads until the user actually hovers a terminal with voice input on:
// requiring this module only registers IPC handlers.

const os = require('os');
const path = require('path');
const { app } = require('electron');
const bridge = require('./remote-bridge');
const { sendToRenderer } = require('./window');
const { createLimiter } = require('./concurrency');
const {
  pickModelId, findModel, modelsRoot, modelFiles, vadPath, modelReady, modelStates,
  normalizeTranscript, shouldEmit, statSize, pickLanguage, whisperLanguage, pinnedRetryLanguage, LANGUAGES,
  SAMPLE_RATE, VAD_CONFIG, VAD_BUFFER_SECONDS, recognizerThreads,
  TAIL_PADDING_SECONDS, withTailPadding,
} = require('./stt-lib');

const TAIL_PADDING = Math.round(SAMPLE_RATE * TAIL_PADDING_SECONDS);

let sherpa = null;      // the native module, loaded on first use
let loadError = null;   // why it couldn't load (reported as unavailable, not thrown)
let recognizer = null;  // LRU-of-1: loading Whisper weights is the expensive step
let recognizerModel = null; // the model id the loaded recognizer holds
let recognizerConfig = null; // its full config — setConfig() must be handed it whole
let loading = null;     // in-flight load, so warm + first arm share one
let vad = null;
let target = null;      // the session id the current capture is dictating into
let targetLanguage = null; // the spoken-language setting that capture was started with
let audioErrorReported = false; // report a broken audio path once, not per chunk

// The addon is not reentrant, so decodes run strictly one at a time. A limiter
// rather than a hand-rolled promise chain: each task settles on its own promise, so
// one failed decode can't poison the queue for the rest of the session.
const decodeQueue = createLimiter(1);

// Electron's paths never change after ready, so resolve the model tree once.
let modelRoot = null;
function root() {
  if (!modelRoot) {
    modelRoot = modelsRoot(
      { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() },
      path.join,
    );
  }
  return modelRoot;
}

function load() {
  if (sherpa || loadError) return sherpa;
  try { sherpa = require('sherpa-onnx-node'); }
  catch (err) {
    loadError = err && err.message ? err.message : String(err);
    console.error('[voice] sherpa-onnx failed to load:', loadError);
  }
  return sherpa;
}

// Deduped: `stt-warm` (on enable) and `stt-start` (on the first hover) both ask for
// the recognizer, and without sharing the in-flight promise they would each load
// ~1 GB of weights concurrently — double the memory and slower than either alone,
// which showed up as an indicator stuck on "Starting…".
// Keyed by model only: the spoken language is swapped per decode with setConfig(),
// which costs nothing (measured: 0 ms, the weights untouched) — so changing language
// never reloads, and the Turkish + English mode can re-decode a phrase pinned.
function ensureRecognizer(modelId) {
  if (recognizer && recognizerModel === modelId) return Promise.resolve(recognizer);
  if (loading && loading.key === modelId) return loading.promise;
  const promise = loadRecognizer(modelId).finally(() => {
    if (loading && loading.key === modelId) loading = null;
  });
  loading = { key: modelId, promise };
  return promise;
}

async function loadRecognizer(modelId) {
  const lib = load();
  if (!lib) throw new Error(`speech recognition is unavailable on this platform: ${loadError}`);
  const dir = root();
  const files = modelFiles(dir, modelId, path.join);
  if (!modelReady(dir, modelId, statSize, path.join)) {
    throw new Error('the voice model is missing — run "npm run fetch:stt" to download it');
  }
  const config = {
    modelConfig: {
      whisper: {
        encoder: files.encoder,
        decoder: files.decoder,
        language: 'en', // replaced per decode, see setWhisperLanguage
        // Never 'translate' — the user must get back what they actually said.
        task: 'transcribe',
      },
      tokens: files.tokens,
      numThreads: recognizerThreads(os.cpus().length),
      provider: 'cpu',
      debug: false,
    },
    decodingMethod: 'greedy_search',
  };
  recognizer = await lib.OfflineRecognizer.createAsync(config);
  recognizerModel = modelId;
  recognizerConfig = config;
  return recognizer;
}

// Point the recognizer at a Whisper language code ('' = detect) before a decode.
// Only ever called inside decodeQueue, so it can't change under a running decode.
function setWhisperLanguage(language) {
  const whisper = recognizerConfig.modelConfig.whisper;
  if (whisper.language === language) return;
  const next = { ...recognizerConfig, modelConfig: { ...recognizerConfig.modelConfig, whisper: { ...whisper, language } } };
  recognizer.setConfig(next);
  recognizerConfig = next;
}

async function decodeOnce(samples, language) {
  setWhisperLanguage(language);
  const stream = recognizer.createStream();
  // Padded: a segment whose audio stops on the final phoneme loses that syllable
  // ("kaydet" -> "kay"). See TAIL_PADDING_SECONDS.
  stream.acceptWaveform({ samples: withTailPadding(samples, TAIL_PADDING), sampleRate: SAMPLE_RATE });
  const result = await recognizer.decodeAsync(stream);
  return { text: (result && result.text) || '', lang: (result && result.lang) || '' };
}

// One phrase in the capture's language setting. An English-only model is always
// pinned to `en` — letting one of those guess produces garbage. In the Turkish +
// English mode a phrase detected as anything else is decoded again pinned.
async function decodeSegment(samples, languageId) {
  const multilingual = !!(findModel(recognizerModel) || {}).multilingual;
  if (!multilingual) return decodeOnce(samples, 'en');
  const first = await decodeOnce(samples, whisperLanguage(languageId));
  const retry = pinnedRetryLanguage(languageId, first.lang);
  return retry ? decodeOnce(samples, retry) : first;
}

function ensureVad() {
  if (vad) return vad;
  const lib = load();
  if (!lib) throw new Error('speech recognition is unavailable on this platform');
  const model = vadPath(root(), path.join);
  if (!statSize(model)) throw new Error('the voice activity model is missing — run "npm run fetch:stt"');
  vad = new lib.Vad({
    sileroVad: { model, ...VAD_CONFIG },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: false,
  }, VAD_BUFFER_SECONDS);
  return vad;
}

// Decode every speech segment the VAD has finished and push its text. The pop loop
// is synchronous (`vad.pop()` invalidates the front, so each segment is copied out
// before any await) and the decoding is queued behind whatever is already running.
function drain() {
  if (!vad || !recognizer) return;
  const segments = [];
  while (!vad.isEmpty()) {
    // `false` = don't hand back an *external* buffer. sherpa-onnx defaults to
    // wrapping its own memory in an external ArrayBuffer, which plain Node accepts
    // but **Electron rejects** with "External buffers are not allowed" (V8 sandbox /
    // pointer compression). Popping a segment then throws, so every phrase is lost
    // while everything up to that point looks healthy. Don't drop this argument.
    const seg = vad.front(false);
    vad.pop();
    if (seg && seg.samples && seg.samples.length) segments.push(seg.samples);
  }
  if (!segments.length) return;
  const forSession = target;
  const language = targetLanguage;
  decodeQueue(async () => {
    // Decoding a phrase takes ~1s, which reads as "nothing happened" unless the
    // indicator says otherwise — so the renderer is told when we're working.
    sendToRenderer('stt-busy', { sessionId: forSession, busy: true });
    try {
      for (const samples of segments) {
        // A stop mid-decode means the user has moved on; drop the rest.
        if (target !== forSession) return;
        const result = await decodeSegment(samples, language);
        // Filter here rather than in the renderer so a silence hallucination never
        // crosses the IPC boundary at all; the renderer only decides spacing.
        const text = normalizeTranscript(result && result.text);
        if (shouldEmit(text)) sendToRenderer('stt-text', { sessionId: forSession, text });
      }
    } catch (err) {
      console.error('[voice] decode failed:', err && err.message);
      sendToRenderer('stt-error', { message: err && err.message ? err.message : String(err) });
    } finally {
      sendToRenderer('stt-busy', { sessionId: forSession, busy: false });
    }
  });
}

// --- IPC ---------------------------------------------------------------------
// Desktop-only: voice input is driven by this machine's keyboard focus (or a held
// New session button) and microphone, so none of these channels are exposed to a
// paired phone.

bridge.handle('stt-status', async () => {
  const dir = root();
  const models = modelStates(dir, statSize, path.join);
  const vadReady = !!statSize(vadPath(dir, path.join));
  const lib = load();
  return {
    available: !!lib && vadReady && models.some((m) => m.ready),
    models,
    languages: LANGUAGES.map(({ id, labelKey }) => ({ id, labelKey })),
    error: lib ? null : loadError,
  };
});

// Load the weights without arming anything. Called when the user switches voice
// input on, so the ~2.7s model load happens then rather than inside the first
// hover, where it would swallow the opening words of the first phrase.
bridge.handle('stt-warm', async (_e, { modelId } = {}) => {
  try {
    await ensureRecognizer(pickModelId(modelId));
    ensureVad();
    return { ok: true };
  } catch (err) {
    console.error('[voice] warm failed:', err && err.message);
    return { error: err && err.message ? err.message : String(err) };
  }
});

// Arm a capture for one session. Cheap once warmed — it only points the recognizer
// at a session and resets the VAD.
bridge.handle('stt-start', async (_e, { sessionId, modelId, language } = {}) => {
  try {
    const id = pickModelId(modelId);
    const lang = pickLanguage(language);
    await ensureRecognizer(id);
    ensureVad();
    vad.reset();
    audioErrorReported = false;
    target = sessionId || null;
    targetLanguage = lang;
    return { ok: true, modelId: id, language: lang };
  } catch (err) {
    console.error('[voice] start failed:', err && err.message);
    return { error: err && err.message ? err.message : String(err) };
  }
});

bridge.on('stt-audio', (_e, samples) => {
  if (!vad || !target || !samples || !samples.length) return;
  try {
    vad.acceptWaveform(samples);
    drain();
  } catch (err) {
    console.error('[voice] accepting audio failed:', err && err.message);
    // Surface it once. Audio arrives ~16x a second, so reporting every failure
    // would spam a dialog per chunk — but reporting none is how a totally broken
    // pipeline ends up looking like "the indicator is on and nothing happens".
    if (!audioErrorReported) {
      audioErrorReported = true;
      sendToRenderer('stt-error', { message: err && err.message ? err.message : String(err) });
    }
  }
});

// Flushing on stop transcribes the phrase in progress instead of discarding it —
// the user stopped hovering mid-sentence, but they still said the words. Resolves
// once that last phrase has been decoded and its `stt-text` sent.
function stopCapture() {
  const stopping = target;
  if (!vad) { target = null; return Promise.resolve(); }
  try { vad.flush(); drain(); } catch (err) { console.error('[voice] flush failed:', err && err.message); }
  // Queued behind the flushed phrase's decode, so it still sees the session it was
  // captured for; the limiter runs tasks FIFO. Only clears the target it stopped:
  // a capture armed meanwhile (dictation handing over to the New session hold)
  // must not be cut off by the previous one's late stop.
  return decodeQueue(() => { if (target === stopping) target = null; });
}
bridge.on('stt-stop', () => { stopCapture(); });

// The New session hold's release: the same stop, awaited, so the renderer knows
// every phrase of the clip has arrived before it creates the session.
bridge.handle('stt-finish', async () => {
  await stopCapture();
  return { ok: true };
});

// Free the weights (hundreds of MB of RAM) when voice input is switched off, and
// on quit.
function stopStt() {
  target = null;
  vad = null;
  recognizer = null;
  recognizerModel = null;
  recognizerConfig = null;
  loading = null;
}
bridge.on('stt-release', () => stopStt());

module.exports = { stopStt };
