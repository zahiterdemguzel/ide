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
//
// `ggml` is the same model for the GPU engine (whisper.cpp on Metal, macOS only — see
// GPU_ENGINE below). q8_0 rather than the ONNX int8: measured on fast speech, the
// sherpa-onnx int8 decode cut long phrases off mid-sentence ("…then add a") and
// invented text for others, while the ggml q8_0 decode was complete — and ~0.5 s on
// an M3 Max GPU instead of 1.5–7 s on 12 CPU threads.
const MODELS = [
  {
    id: 'turbo',
    label: 'Whisper large-v3-turbo',
    archive: 'sherpa-onnx-whisper-turbo.tar.bz2',
    bytes: 563790207,
    multilingual: true,
    ggml: {
      name: 'ggml-large-v3-turbo-q8_0.bin',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
      bytes: 874188075,
    },
  },
];

// --- GPU engine (whisper.cpp on Metal) ---------------------------------------
//
// On macOS, phrases are decoded by a whisper.cpp `whisper-server` sidecar built from
// source at install time (scripts/build-whisper-server.mjs) with the Metal backend
// and its shader library embedded, so it is one self-contained binary that links
// only system frameworks. Everywhere else — or when the build or the ggml download
// failed — the sherpa-onnx CPU engine is used, as before. sherpa-onnx stays loaded on
// macOS either way: its Silero VAD still cuts the stream into phrases.
const ENGINE_GPU = 'whisper.cpp';
const ENGINE_CPU = 'sherpa-onnx';

const GPU_ENGINE = {
  tag: 'v1.9.6',
  sourceUrl: 'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.6.tar.gz',
  binary: 'whisper-server',
  // The GPU does the work, so the sidecar needs few CPU threads.
  threads: 4,
};

const gpuEngineSupported = (platform) => platform === 'darwin';

function gpuEngineFiles(root, id, join) {
  const model = findModel(id);
  return {
    binary: join(root, 'bin', GPU_ENGINE.binary),
    model: model && model.ggml ? join(root, 'ggml', model.ggml.name) : null,
  };
}

// The GPU engine is usable when the platform supports it, the server binary is
// there and the ggml weights are complete (exact size — a cut download must read as
// missing, not as a model that loads garbage).
function gpuEngineReady(root, id, statSize, join, platform) {
  const model = findModel(id);
  if (!gpuEngineSupported(platform) || !model || !model.ggml) return false;
  const files = gpuEngineFiles(root, id, join);
  return (statSize(files.binary) || 0) > 0 && statSize(files.model) === model.ggml.bytes;
}

// Which engine decodes `id`: the GPU one when it's ready, the CPU one otherwise,
// null when neither is installed.
function pickEngine({ gpuReady, cpuReady }) {
  if (gpuReady) return ENGINE_GPU;
  if (cpuReady) return ENGINE_CPU;
  return null;
}

// What each platform's installer carries for the bundled models — the number the
// 1 GB budget is about. macOS ships the ggml weights instead of the ONNX archive.
function bundledModelBytes(platform) {
  return MODELS.reduce((sum, m) => sum + (gpuEngineSupported(platform) && m.ggml ? m.ggml.bytes : m.bytes), 0);
}

// The sidecar's command line. Loopback only, on a port picked free per app instance
// (several instances may run). `-l auto` is only the default — every request sends
// its own language.
function whisperServerArgs({ model, port, threads = GPU_ENGINE.threads }) {
  return ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-l', 'auto'];
}

// The language whisper.cpp should decode a phrase in: '' (detect) becomes 'auto'.
const serverLanguage = (whisper) => whisper || 'auto';

// The most likely language in whisper.cpp's `language_probabilities` (code → p), or ''.
function topLanguage(probabilities) {
  let best = '';
  let bestP = -1;
  for (const [code, p] of Object.entries(probabilities || {})) {
    if (typeof p === 'number' && p > bestP) { best = code; bestP = p; }
  }
  return best;
}

const DEFAULT_MODEL_ID = 'turbo';

// The dictation languages offered in Settings. `auto` ('' to Whisper) detects the
// language per *segment*, which is what lets a sentence mix Turkish and English —
// but segments here are often under a second, and Whisper's language ID is
// unreliable on clips that short. A misdetected phrase comes back as garbage even
// though the audio was fine, so pinning a language is the fix for "it transcribes
// nonsense sometimes", and it skips the detection pass as a bonus.
//
// `en-tr` is auto-detect fenced to Turkish and English — one mode for a speaker who
// uses both, mid-sentence even. Each phrase is detected; a phrase Whisper calls some
// third language (Turkish's neighbours az/uz are the realistic misfire) is decoded
// again pinned to `fallback`. A clean detection, the normal case, costs nothing extra.
//
// Deliberately a handful of options rather than all 99 Whisper knows: this is a
// dictation box, not a translation tool. `labelKey` is an i18n key — these are UI
// words, not product names. Removing a language is deleting one entry here.
const LANGUAGES = [
  { id: 'en-tr', whisper: '', labelKey: 'voice.langEnTr', fence: ['en', 'tr'], fallback: 'tr' },
  { id: 'auto', whisper: '', labelKey: 'voice.langAuto' },
  { id: 'en', whisper: 'en', labelKey: 'voice.langEnglish' },
  { id: 'tr', whisper: 'tr', labelKey: 'voice.langTurkish' },
];

// Turkish + English rather than open auto: the fence turns auto's per-segment
// misdetection into a retry, while still taking either language without a setting.
const DEFAULT_LANGUAGE = 'en-tr';

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

// After a decode in `id`'s mode: the Whisper code to decode the phrase again with, or
// null to keep the result. Only a fenced mode retries, and only when the detected
// language (`result.lang`) falls outside its fence. With the per-language
// probabilities whisper.cpp reports, the retry goes to whichever fenced language
// scored higher — measured: a fast mixed Turkish/English phrase detected as Russian
// had tr 0.19 vs en 0.12 — and to `fallback` without them.
function pinnedRetryLanguage(id, detected, probabilities = null) {
  const lang = findLanguage(id);
  if (!lang || !lang.fence || !detected) return null;
  if (lang.fence.includes(detected)) return null;
  const scored = lang.fence.filter((code) => typeof (probabilities || {})[code] === 'number');
  if (!scored.length) return lang.fallback;
  return scored.reduce((best, code) => (probabilities[code] > probabilities[best] ? code : best));
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
// `isPackaged` alone can't tell: Electron derives it from the executable's name, so a
// dev tree run through a renamed Electron binary (the Dock-icon wrapper's
// `Electron-real`) reports packaged. A real build's app sits inside its resources.
function modelsRoot({ isPackaged, resourcesPath, appPath }, join) {
  const builtApp = isPackaged && !!resourcesPath && isInside(appPath, resourcesPath);
  return builtApp ? join(resourcesPath, 'stt') : join(appPath, 'vendor', 'stt');
}

function isInside(child, parent) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(child).startsWith(`${norm(parent)}/`);
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
// A model counts as ready when either engine can decode it (`platform` decides
// whether the GPU one is an option).
function modelStates(root, statSize, join, platform = '') {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    ready: modelReady(root, m.id, statSize, join) || gpuEngineReady(root, m.id, statSize, join, platform),
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
  return withSilence(samples, 0, padSamples);
}

// Silence put in front of every phrase for the GPU engine. A VAD phrase starts right
// on its first syllable, and with a prompt whisper.cpp then sometimes skipped ahead —
// measured: a 12 s phrase came back as only its last sentence, and the same audio
// with 0.2 s of lead-in came back whole. 0.5 s cut another phrase short, so 0.2.
const LEAD_PADDING_SECONDS = 0.2;

// `samples` with `lead` zeros before and `tail` zeros after (counts in samples).
function withSilence(samples, lead, tail) {
  if (!samples || !samples.length) return samples;
  const before = lead > 0 ? lead : 0;
  const after = tail > 0 ? tail : 0;
  if (!before && !after) return samples;
  const out = new Float32Array(before + samples.length + after);
  out.set(samples, before);
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

// With the GPU engine a phrase decodes in ~0.5 s, so some of that saving goes into
// longer phrases: Whisper reads a phrase with its neighbours far better than a
// fragment cut at every breath (measured: a fast mixed sentence alone came back as
// noise, the same audio inside a longer clip came back right). A fast talker's
// in-sentence gaps are under half a second, so they no longer end a phrase.
const GPU_VAD_CONFIG = { ...VAD_CONFIG, minSilenceDuration: 0.5, maxSpeechDuration: 20 };

function vadConfigFor(engine) {
  return engine === ENGINE_GPU ? GPU_VAD_CONFIG : VAD_CONFIG;
}

// CPU engine only (the GPU engine runs on GPU_ENGINE.threads).
// Whisper always encodes a padded 30-second window, so a phrase costs about the
// same to decode however short it is — on the CPU, thread count is the only lever on how
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

// Whisper punctuates what it hears, but this text is typed into a prompt the user
// keeps editing, so the sentence dots and commas are noise they then have to delete.
// Dropped unless they sit between digits (3.14, 1,000), where they're part of the
// number rather than punctuation.
const SENTENCE_PUNCTUATION = /(?<!\d)[.,]|[.,](?!\d)/g;

// Recognized text as it should appear: no surrounding whitespace, no bracketed
// sound events, no sentence dots/commas, single spaces. Returns '' for anything
// with no words left.
function normalizeTranscript(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(NON_SPEECH, ' ')
    .replace(SENTENCE_PUNCTUATION, '')
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
// punctuation, and the silence hallucinations above, and — when the decode was
// given a prompt — Whisper echoing that prompt back for audio it couldn't read.
function shouldEmit(text, prompt = '') {
  const key = speechKey(text);
  if (!key) return false;
  if (HALLUCINATIONS.includes(key)) return false;
  return !echoesPrompt(key, prompt);
}

// --- decode context (GPU engine) ---------------------------------------------

// The vocabulary the dictation is full of, given to Whisper as its prompt. Spoken in
// a Turkish sentence these come back phonetically spelled without it — measured:
// "pull request'i … merge conflict" decoded as "pullukı … merke konflikt", and right
// with this prompt. Written as a sentence in the speaker's own mix rather than a word
// list: Whisper reads a prompt as the transcript so far, and a bare list made it echo
// the list and loop ("Pull request merge conflict march march march…") on a fast
// phrase, where this sentence read it right. Kept short for the same reason.
const VOCABULARY_PROMPT = "Şu pull request'i incele, merge conflict varsa çöz, commit'le ve branch'i push et. Then run lint and the tests.";

// How much of what was already said in this capture rides along as context.
const CONTEXT_PROMPT_CHARS = 200;

// The prompt for the next phrase: the vocabulary, then the tail of the capture so far
// (cut at a word boundary), so a phrase split at a pause still reads as one sentence.
function decodePrompt(previousText = '') {
  const said = String(previousText || '').replace(/\s+/g, ' ').trim();
  if (!said) return VOCABULARY_PROMPT;
  let tail = said.length > CONTEXT_PROMPT_CHARS ? said.slice(-CONTEXT_PROMPT_CHARS) : said;
  if (tail.length < said.length) tail = tail.replace(/^\S*\s/, '');
  return `${VOCABULARY_PROMPT} ${tail}`;
}

// Did Whisper just repeat its vocabulary sentence instead of transcribing? Checked
// against VOCABULARY_PROMPT only — never the context tail, or saying a phrase twice
// in one capture would drop the second — and only for a result that is a long run of
// it: the vocabulary is exactly what this user says, so "merge conflict varsa çöz"
// or "run lint" must survive.
// An echo has to cover at least half the sentence (10 of its 20 words).
const ECHO_MIN_SHARE = 0.5;

function echoesPrompt(key, prompt) {
  if (!prompt) return false;
  const vocabulary = speechKey(VOCABULARY_PROMPT);
  const minWords = Math.ceil(vocabulary.split(' ').length * ECHO_MIN_SHARE);
  if (key.split(' ').length < minWords) return false;
  return ` ${vocabulary} `.includes(` ${key} `);
}

// Whisper's other failure on unclear audio: a word or short phrase repeated over and
// over. Up to three-word groups, repeated `minRuns` times in a row.
const MAX_LOOP_WORDS = 3;

function repetitionRun(words, at, size) {
  let runs = 1;
  const unit = words.slice(at, at + size).join(' ');
  while (words.slice(at + runs * size, at + (runs + 1) * size).join(' ') === unit) runs++;
  return runs;
}

function hasRepetitionLoop(text, minRuns = 4) {
  const words = speechKey(String(text || '')).split(' ').filter(Boolean);
  for (let size = 1; size <= MAX_LOOP_WORDS; size++) {
    for (let at = 0; at + size * minRuns <= words.length; at++) {
      if (repetitionRun(words, at, size) >= minRuns) return true;
    }
  }
  return false;
}

// The last resort when a loop survives a re-decode: each run of three or more
// repeats is cut to one occurrence, so the user gets the phrase once, not a wall.
function collapseRepetitions(text, minRuns = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const key = (w) => speechKey(w);
  const out = [];
  for (let at = 0; at < words.length;) {
    let collapsed = false;
    for (let size = MAX_LOOP_WORDS; size >= 1 && !collapsed; size--) {
      const unit = words.slice(at, at + size).map(key).join(' ');
      let runs = 1;
      while (at + (runs + 1) * size <= words.length
        && words.slice(at + runs * size, at + (runs + 1) * size).map(key).join(' ') === unit) runs++;
      if (runs >= minRuns) {
        out.push(...words.slice(at, at + size));
        at += runs * size;
        collapsed = true;
      }
    }
    if (!collapsed) { out.push(words[at]); at++; }
  }
  return out.join(' ');
}

// A whisper-server `verbose_json` answer as one string. Its `text` puts a newline
// between segments, and segments can break mid-word ("gün" | "celle"); a segment
// that starts a new word carries its own leading space, so gluing the segment texts
// together with nothing between them restores the words.
function joinSegmentTexts(json) {
  if (!json) return '';
  const segments = Array.isArray(json.segments) ? json.segments : [];
  if (!segments.length) return typeof json.text === 'string' ? json.text : '';
  return segments.map((s) => (s && typeof s.text === 'string' ? s.text : '')).join('');
}

// Mono Float32 samples → a 16-bit PCM WAV file, the upload whisper-server expects.
function samplesToWav16(samples, rate = SAMPLE_RATE) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

// --- clips recorded on a paired phone ----------------------------------------

// The phone records what it hears while you speak a task and hands the clip to this
// machine's Whisper, because its own recognizer handles one language per capture and
// mangles the Turkish + English mix this recognizer is tuned for. Capped so one
// request stays far under the relay's frame size (3 min of 16 kHz PCM16 ≈ 7.7 MB in
// base64) and a decode can't hold the queue for minutes.
const MAX_CLIP_SECONDS = 180;

// Little-endian RIFF/WAVE → mono Float32 samples at SAMPLE_RATE. Android writes PCM16
// at 16 kHz mono and iOS Float32 at 44.1/48 kHz, so both encodings, any channel
// count and any rate are accepted: channels are averaged and the rate resampled.
function wavToSamples(buf) {
  if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // A recorder killed mid-write leaves the size unpatched (0 or 0xFFFFFFFF);
      // take what is actually there.
      const end = size === 0 || body + size > buf.length ? buf.length : body + size;
      data = buf.subarray(body, end);
    }
    at = body + size + (size & 1); // chunks are word-aligned
    if (data && fmt) break;
  }
  if (!fmt || !data) throw new Error('WAV file has no audio');
  const pcm16 = fmt.format === 1 && fmt.bits === 16;
  const float32 = fmt.format === 3 && fmt.bits === 32;
  if (!pcm16 && !float32) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
  const channels = Math.max(1, fmt.channels);
  const bytesPerFrame = (fmt.bits / 8) * channels;
  const frames = Math.floor(data.length / bytesPerFrame);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = i * bytesPerFrame + c * (fmt.bits / 8);
      sum += pcm16 ? data.readInt16LE(off) / 32768 : data.readFloatLE(off);
    }
    mono[i] = sum / channels;
  }
  return resampleLinear(mono, fmt.rate, SAMPLE_RATE);
}

// Linear interpolation is plenty for speech headed into Whisper's 16 kHz front end.
function resampleLinear(samples, from, to) {
  if (!from || from === to || !samples.length) return samples;
  const length = Math.max(1, Math.round(samples.length * to / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = pos - left;
    out[i] = samples[Math.min(left, samples.length - 1)] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

// Several clips (the phone restarts its recognizer at pauses on older Android, and
// each restart writes a new file) as one stream, in the order they were recorded.
function concatSamples(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// The decoded phrases of a clip as one prompt, with hallucinated/empty ones dropped
// exactly as live dictation drops them.
// A phrase may arrive as `{ text, prompt }` so its prompt-echo check uses the prompt
// that phrase was decoded with.
function joinClipPhrases(phrases) {
  return phrases
    .map((p) => (p && typeof p === 'object' ? p : { text: p, prompt: '' }))
    .map((p) => ({ text: normalizeTranscript(p.text), prompt: p.prompt || '' }))
    .filter((p) => shouldEmit(p.text, p.prompt))
    .map((p) => p.text)
    .join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  MODELS,
  DEFAULT_MODEL_ID,
  ENGINE_GPU,
  ENGINE_CPU,
  GPU_ENGINE,
  gpuEngineSupported,
  gpuEngineFiles,
  gpuEngineReady,
  pickEngine,
  bundledModelBytes,
  whisperServerArgs,
  serverLanguage,
  topLanguage,
  GPU_VAD_CONFIG,
  vadConfigFor,
  VOCABULARY_PROMPT,
  decodePrompt,
  echoesPrompt,
  hasRepetitionLoop,
  collapseRepetitions,
  joinSegmentTexts,
  samplesToWav16,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  findLanguage,
  pickLanguage,
  whisperLanguage,
  pinnedRetryLanguage,
  VAD_ASSET,
  VAD_CONFIG,
  VAD_BUFFER_SECONDS,
  SAMPLE_RATE,
  TAIL_PADDING_SECONDS,
  withTailPadding,
  LEAD_PADDING_SECONDS,
  withSilence,
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
  MAX_CLIP_SECONDS,
  wavToSamples,
  resampleLinear,
  concatSamples,
  joinClipPhrases,
};
