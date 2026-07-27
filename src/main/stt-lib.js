// Pure decisions for the voice-input (speech-to-text) feature: which models exist,
// where their files live, and which recognized text is worth typing into a session.
// Electron-free so it's unit-testable and so the install-time fetch script
// (scripts/fetch-stt-model.mjs, an ES module) can import the same registry the main
// process uses — the downloader and the engine must never disagree about a filename
// or about what "installed" means.

const fs = require('fs');

// The one definition of "how big is this file, or null if it isn't there". Both the
// engine and the downloader probe readiness through this, so they can't drift on
// what counts as missing — `modelReady` below is written against exactly this
// contract (null when absent, and a non-empty size required).
const statSize = (file) => { try { return fs.statSync(file).size; } catch { return null; } };

// The bundled Whisper models, fetched at install time and shipped as
// extraResources. int8 quantizations only — the archives also carry fp32 weights,
// which would triple the installer for no quality gain on dictation.
//
// Only large-v3-turbo ships: it is the highest-quality Whisper that fits the 1 GB
// budget for bundled weights (989 MB extracted; large-v3 is ~1.5 GB). A second,
// smaller model would have to fit in the remaining 35 MB, and none does — even
// tiny.en is ~50 MB. Adding one later is just another entry here plus the fetch;
// everything downstream (the dropdown, the readiness check) is already plural.
//
// `bytes` is the published size of the release asset — used as the download's
// integrity check. The GitHub release exposes no checksum for these assets, so an
// exact-size match plus a successful bzip2 extraction is the strongest gate
// available without hand-maintaining digests that would silently rot when k2-fsa
// re-uploads the tag.
const MODELS = [
  {
    id: 'turbo',
    label: 'Whisper large-v3-turbo',
    archive: 'sherpa-onnx-whisper-turbo.tar.bz2',
    bytes: 563790207,
    multilingual: true,
  },
];

const DEFAULT_MODEL_ID = 'turbo';

// The dictation languages offered in Settings. `auto` ('' to Whisper) detects the
// language per *segment*, which is what lets a sentence mix Turkish and English —
// but segments here are often under a second, and Whisper's language ID is
// unreliable on clips that short. A misdetected phrase comes back as garbage even
// though the audio was fine, so pinning a language is the fix for "it transcribes
// nonsense sometimes", and it skips the detection pass as a bonus.
//
// Deliberately three options rather than all 99 Whisper knows: this is a dictation
// box, not a translation tool. `labelKey` is an i18n key — these are UI words, not
// product names. Removing a language is deleting one entry here.
const LANGUAGES = [
  { id: 'auto', whisper: '', labelKey: 'voice.langAuto' },
  { id: 'en', whisper: 'en', labelKey: 'voice.langEnglish' },
  { id: 'tr', whisper: 'tr', labelKey: 'voice.langTurkish' },
];

// English rather than auto: auto's per-segment misdetection is the bigger practical
// risk, and a pinned language is always at least as accurate for that language.
const DEFAULT_LANGUAGE = 'en';

function findLanguage(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

// A stored/incoming language resolved to one we offer, for the same reason as
// pickModelId: a stale localStorage value must not break dictation. An English-only
// model ignores this entirely and is pinned to `en` by the caller.
function pickLanguage(id) {
  return findLanguage(id) ? id : DEFAULT_LANGUAGE;
}

// What Whisper's `language` config field should be for a chosen language id.
function whisperLanguage(id) {
  return (findLanguage(id) || findLanguage(DEFAULT_LANGUAGE)).whisper;
}

// Silero VAD — segments the mic stream on natural pauses so each phrase is
// recognized as soon as the speaker stops, instead of only when they stop hovering.
const VAD_ASSET = { name: 'silero_vad.onnx', bytes: 643854 };

const RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

// After extraction every model is normalized to these three names, whatever the
// archive called them internally (`turbo-encoder.int8.onnx`, `base.en-encoder.int8.onnx`,
// …). The engine then needs no per-model path knowledge.
const ENCODER_FILE = 'encoder.int8.onnx';
const DECODER_FILE = 'decoder.int8.onnx';
const TOKENS_FILE = 'tokens.txt';

function assetUrl(name) {
  return `${RELEASE_BASE}/${name}`;
}

function findModel(id) {
  return MODELS.find((m) => m.id === id) || null;
}

// A stored/incoming model id resolved to one we actually ship. An unknown or
// missing value falls back to the default rather than failing — a bad
// localStorage value must not leave voice input permanently broken.
function pickModelId(id) {
  return findModel(id) ? id : DEFAULT_MODEL_ID;
}

// Where the model tree lives. Packaged builds get it from extraResources
// (`<resources>/stt`); in dev it's the gitignored `vendor/stt` the fetch script
// writes. Kept pure (the caller passes Electron's paths) so it's testable.
function modelsRoot({ isPackaged, resourcesPath, appPath }, join) {
  return isPackaged ? join(resourcesPath, 'stt') : join(appPath, 'vendor', 'stt');
}

function modelFiles(root, id, join) {
  const dir = join(root, id);
  return {
    dir,
    encoder: join(dir, ENCODER_FILE),
    decoder: join(dir, DECODER_FILE),
    tokens: join(dir, TOKENS_FILE),
  };
}

function vadPath(root, join) {
  return join(root, VAD_ASSET.name);
}

// Is a model usable? All three files must be present and non-empty — a truncated
// download that left a 0-byte encoder must read as missing, not as ready.
function modelReady(root, id, statSize, join) {
  const files = modelFiles(root, id, join);
  return [files.encoder, files.decoder, files.tokens].every((f) => {
    const size = statSize(f);
    return typeof size === 'number' && size > 0;
  });
}

// Which models are installed, for the settings dropdown. Every model is always
// listed; `ready: false` rows are shown but not selectable, so a failed
// install-time fetch is visible rather than a silently empty menu.
function modelStates(root, statSize, join) {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    ready: modelReady(root, m.id, statSize, join),
  }));
}

// --- audio shaping -----------------------------------------------------------

// Silence appended to every segment before decoding. Whisper truncates the last
// syllable of an utterance whose audio stops dead on the final phoneme — measured:
// "kaydet" came back "kay", "oluştur" came back "oluş", and the same clip with
// 0.5s of trailing silence transcribed perfectly. Whisper pads every clip to a
// 30-second window anyway, so these zeros cost nothing.
const TAIL_PADDING_SECONDS = 0.4;

// A copy of `samples` with `padSamples` zeros appended. Returns the input untouched
// when there's nothing to add, so the common path allocates only when it must.
function withTailPadding(samples, padSamples) {
  if (!samples || !samples.length) return samples;
  if (!(padSamples > 0)) return samples;
  const out = new Float32Array(samples.length + padSamples);
  out.set(samples, 0);
  return out;
}

// --- runtime tuning ----------------------------------------------------------

// Silero VAD, tuned for dictation by a fast talker: a short silence still ends a
// phrase (so text lands quickly), but a long sentence is force-cut at
// maxSpeechDuration so the user never waits on a monologue with no pause in it.
const VAD_CONFIG = {
  threshold: 0.5,
  minSilenceDuration: 0.35,
  minSpeechDuration: 0.15,
  maxSpeechDuration: 12,
  windowSize: 512,
};
const SAMPLE_RATE = 16000;
const VAD_BUFFER_SECONDS = 30;

// Whisper always encodes a padded 30-second window, so a phrase costs about the
// same to decode however short it is — thread count is the only real lever on how
// long the user waits for their words. Measured on turbo int8: 2 threads 3.2s,
// 4 → 2.7s, 8 → 1.6s, 12 → 1.1s, and it plateaus after that. Two cores are left
// for the IDE itself so dictation can't make the rest of the app stutter.
// Defensive against `os.cpus()` returning [] (seen in some Linux containers).
function recognizerThreads(cpuCount) {
  const cpus = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 4;
  return Math.max(2, Math.min(12, cpus - 2));
}

// --- transcript filtering ----------------------------------------------------

// Whisper hallucinates stock phrases on near-silent audio — it was trained on
// subtitle corpora, so a VAD segment that caught only a keyboard click or a breath
// comes back as a caption artifact. Typing those into the session would be worse
// than dropping them, so any segment whose entire content is one of these is
// discarded. Matched after normalization, case- and punctuation-insensitive.
const HALLUCINATIONS = [
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thanks',
  'you',
  'bye',
  'okay',
  'oh',
  'hmm',
  'mm',
  'uh',
  'um',
  'subtitles by the amara org community',
  'transcription by castingwords',
  'subs by www zeoranger co uk',
  'please subscribe',
  'blank audio',
  'silence',
  'music',
  'applause',
];

// Bracketed non-speech events Whisper emits: [BLANK_AUDIO], (music), *laughs*.
const NON_SPEECH = /[[(*][^\])*]*[\])*]/g;

// Recognized text as it should appear: no surrounding whitespace, no bracketed
// sound events, single spaces. Returns '' for anything with no words left.
function normalizeTranscript(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(NON_SPEECH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The comparison key for the hallucination list: letters, digits and spaces only.
// Punctuation becomes a space rather than being deleted, so "Amara.org" and
// "Amara org" produce the same key.
function speechKey(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Should this segment be typed into the session? Guards empty results, pure
// punctuation, and the silence hallucinations above.
function shouldEmit(text) {
  const key = speechKey(text);
  if (!key) return false;
  return !HALLUCINATIONS.includes(key);
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  findLanguage,
  pickLanguage,
  whisperLanguage,
  VAD_ASSET,
  VAD_CONFIG,
  VAD_BUFFER_SECONDS,
  SAMPLE_RATE,
  TAIL_PADDING_SECONDS,
  withTailPadding,
  recognizerThreads,
  statSize,
  assetUrl,
  findModel,
  pickModelId,
  modelsRoot,
  modelFiles,
  vadPath,
  modelReady,
  modelStates,
  normalizeTranscript,
  shouldEmit,
};
