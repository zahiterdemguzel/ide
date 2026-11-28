const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  MODELS, DEFAULT_MODEL_ID, VAD_ASSET, assetUrl, findModel, pickModelId,
  modelsRoot, modelFiles, vadPath, modelReady, modelStates,
  normalizeTranscript, shouldEmit, recognizerThreads,
  LANGUAGES, DEFAULT_LANGUAGE, pickLanguage, whisperLanguage, pinnedRetryLanguage,
  withTailPadding, TAIL_PADDING_SECONDS,
  ENGINE_GPU, ENGINE_CPU, GPU_ENGINE, gpuEngineSupported, gpuEngineFiles, gpuEngineReady, pickEngine,
  bundledModelBytes, whisperServerArgs, serverLanguage, topLanguage, VAD_CONFIG, GPU_VAD_CONFIG, vadConfigFor,
  VOCABULARY_PROMPT, decodePrompt, echoesPrompt, hasRepetitionLoop, collapseRepetitions, samplesToWav16,
  joinSegmentTexts, withSilence, LEAD_PADDING_SECONDS,
} = require('../src/main/stt-lib');

// --- registry ----------------------------------------------------------------

test('every bundled model names an archive and its exact published size', () => {
  assert.ok(MODELS.length > 0);
  for (const m of MODELS) {
    assert.match(m.archive, /\.tar\.bz2$/);
    assert.ok(Number.isInteger(m.bytes) && m.bytes > 0, `${m.id} needs a byte size`);
    assert.equal(typeof m.label, 'string');
  }
});

test('the default model is one we actually ship', () => {
  assert.ok(findModel(DEFAULT_MODEL_ID));
});

test('the bundled weights stay inside the 1 GB budget on every platform', () => {
  // The compressed total is the number the installer pays for; the extracted
  // turbo tree is ~990 MB. macOS ships the ggml weights for the GPU engine instead
  // of the ONNX archive. A second model would blow the budget, which is why this
  // asserts rather than trusting a comment.
  for (const platform of ['darwin', 'win32', 'linux']) {
    const total = bundledModelBytes(platform);
    assert.ok(total < 1e9, `${platform} bundles ${total} bytes`);
  }
  assert.equal(bundledModelBytes('win32'), MODELS.reduce((sum, m) => sum + m.bytes, 0));
  assert.equal(bundledModelBytes('darwin'), MODELS.reduce((sum, m) => sum + (m.ggml ? m.ggml.bytes : m.bytes), 0));
});

test('pickModelId falls back to the default for unknown or missing values', () => {
  assert.equal(pickModelId('turbo'), 'turbo');
  assert.equal(pickModelId('no-such-model'), DEFAULT_MODEL_ID);
  assert.equal(pickModelId(undefined), DEFAULT_MODEL_ID);
  assert.equal(pickModelId(''), DEFAULT_MODEL_ID);
  assert.equal(pickModelId(null), DEFAULT_MODEL_ID);
});

test('asset URLs point at the sherpa-onnx release the sizes came from', () => {
  assert.equal(
    assetUrl(VAD_ASSET.name),
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  );
});

// --- paths -------------------------------------------------------------------

test('packaged builds read the models from extraResources, dev from vendor/', () => {
  const packaged = modelsRoot(
    { isPackaged: true, resourcesPath: '/app/Resources', appPath: '/app/Resources/app.asar' },
    path.posix.join,
  );
  assert.equal(packaged, '/app/Resources/stt');

  const dev = modelsRoot(
    { isPackaged: false, resourcesPath: '/ignored', appPath: '/repo' },
    path.posix.join,
  );
  assert.equal(dev, '/repo/vendor/stt');
});

test('a dev tree run through a renamed Electron binary still reads vendor/', () => {
  // Electron reports isPackaged from the executable's name, so the Dock-icon wrapper
  // (`Electron-real` running the repo) claims to be packaged. Its app isn't inside
  // the bundle's resources, though — that's what decides.
  const wrapped = modelsRoot(
    { isPackaged: true, resourcesPath: '/Applications/IDE (Dev).app/Contents/Resources', appPath: '/Users/me/ide' },
    path.posix.join,
  );
  assert.equal(wrapped, '/Users/me/ide/vendor/stt');
  // An unpacked (asar: false) build keeps its app in resources too.
  const unpacked = modelsRoot(
    { isPackaged: true, resourcesPath: '/app/Resources', appPath: '/app/Resources/app' },
    path.posix.join,
  );
  assert.equal(unpacked, '/app/Resources/stt');
  // Windows separators, and a sibling folder that merely shares the prefix.
  assert.equal(
    modelsRoot({ isPackaged: true, resourcesPath: 'C:\\IDE\\resources', appPath: 'C:\\IDE\\resources\\app.asar' }, path.posix.join),
    'C:\\IDE\\resources/stt',
  );
  assert.equal(
    modelsRoot({ isPackaged: true, resourcesPath: '/x/Resources', appPath: '/x/Resources-dev' }, path.posix.join),
    '/x/Resources-dev/vendor/stt',
  );
});

test('model files use the normalized names the fetch script writes', () => {
  const files = modelFiles('/root', 'turbo', path.posix.join);
  assert.equal(files.dir, '/root/turbo');
  assert.equal(files.encoder, '/root/turbo/encoder.int8.onnx');
  assert.equal(files.decoder, '/root/turbo/decoder.int8.onnx');
  assert.equal(files.tokens, '/root/turbo/tokens.txt');
  assert.equal(vadPath('/root', path.posix.join), '/root/silero_vad.onnx');
});

// --- readiness ---------------------------------------------------------------

const sizes = (map) => (f) => (f in map ? map[f] : null);

test('a model is ready only when all three files are present and non-empty', () => {
  const full = {
    '/r/turbo/encoder.int8.onnx': 100,
    '/r/turbo/decoder.int8.onnx': 100,
    '/r/turbo/tokens.txt': 10,
  };
  assert.equal(modelReady('/r', 'turbo', sizes(full), path.posix.join), true);

  const missingTokens = { ...full };
  delete missingTokens['/r/turbo/tokens.txt'];
  assert.equal(modelReady('/r', 'turbo', sizes(missingTokens), path.posix.join), false);
});

test('a truncated (0-byte) weight file reads as not ready, not as ready', () => {
  const truncated = {
    '/r/turbo/encoder.int8.onnx': 0,
    '/r/turbo/decoder.int8.onnx': 100,
    '/r/turbo/tokens.txt': 10,
  };
  assert.equal(modelReady('/r', 'turbo', sizes(truncated), path.posix.join), false);
});

test('modelStates lists every model, marking which ones are on disk', () => {
  const states = modelStates('/r', () => null, path.posix.join);
  assert.equal(states.length, MODELS.length);
  assert.deepEqual(states.map((s) => s.ready), MODELS.map(() => false));
  for (const s of states) assert.equal(typeof s.label, 'string');
});

// --- tail padding ------------------------------------------------------------

test('withTailPadding appends silence without disturbing the speech', () => {
  // Whisper drops the last syllable of a clip that ends on the final phoneme, so
  // every segment gets trailing zeros before it is decoded.
  const speech = Float32Array.from([0.5, -0.5, 0.25]);
  const padded = withTailPadding(speech, 4);
  assert.equal(padded.length, 7);
  assert.deepEqual(Array.from(padded.subarray(0, 3)), [0.5, -0.5, 0.25]);
  assert.deepEqual(Array.from(padded.subarray(3)), [0, 0, 0, 0]);
  // The input must not be mutated — the VAD owns that buffer.
  assert.equal(speech.length, 3);
});

test('withTailPadding allocates nothing when there is nothing to do', () => {
  const speech = Float32Array.from([1, 2]);
  assert.equal(withTailPadding(speech, 0), speech);
  assert.equal(withTailPadding(speech, -1), speech);
  const empty = new Float32Array(0);
  assert.equal(withTailPadding(empty, 100), empty);
});

test('the tail padding is long enough to matter but not a whole phrase', () => {
  assert.ok(TAIL_PADDING_SECONDS >= 0.2 && TAIL_PADDING_SECONDS <= 1);
});

// --- languages ---------------------------------------------------------------

test('every offered language carries a translatable label and a whisper code', () => {
  for (const l of LANGUAGES) {
    assert.match(l.labelKey, /^voice\./, `${l.id} needs an i18n key, not a literal`);
    assert.equal(typeof l.whisper, 'string');
  }
  assert.ok(LANGUAGES.some((l) => l.id === DEFAULT_LANGUAGE));
});

test('auto-detect is the empty string Whisper expects, not a code', () => {
  assert.equal(whisperLanguage('auto'), '');
  assert.equal(whisperLanguage('en'), 'en');
  assert.equal(whisperLanguage('tr'), 'tr');
});

test('the default takes Turkish and English, fenced rather than open auto', () => {
  // Open auto-detect runs per segment, and short clips are where Whisper's language
  // ID misfires into a confidently wrong transcript. The default detects, but only
  // keeps an English or Turkish result — anything else is decoded again pinned.
  assert.notEqual(DEFAULT_LANGUAGE, 'auto');
  const lang = LANGUAGES.find((l) => l.id === DEFAULT_LANGUAGE);
  assert.deepEqual([...lang.fence].sort(), ['en', 'tr']);
  assert.equal(whisperLanguage(DEFAULT_LANGUAGE), '');
});

test('pinnedRetryLanguage re-decodes only a fenced phrase detected outside the fence', () => {
  assert.equal(pinnedRetryLanguage('en-tr', 'tr'), null);
  assert.equal(pinnedRetryLanguage('en-tr', 'en'), null);
  assert.equal(pinnedRetryLanguage('en-tr', 'az'), 'tr'); // Turkish's realistic misfire
  assert.equal(pinnedRetryLanguage('en-tr', 'uz'), 'tr');
  assert.equal(pinnedRetryLanguage('en-tr', ''), null); // nothing detected: keep it
  // Open auto and pinned languages never retry.
  assert.equal(pinnedRetryLanguage('auto', 'az'), null);
  assert.equal(pinnedRetryLanguage('en', 'tr'), null);
  assert.equal(pinnedRetryLanguage('kl', 'az'), null);
  for (const l of LANGUAGES.filter((x) => x.fence)) {
    assert.ok(l.fence.includes(l.fallback), `${l.id}'s fallback must be inside its fence`);
  }
});

test('pickLanguage falls back to the default for unknown or missing values', () => {
  assert.equal(pickLanguage('tr'), 'tr');
  assert.equal(pickLanguage('auto'), 'auto');
  assert.equal(pickLanguage('kl'), DEFAULT_LANGUAGE);
  assert.equal(pickLanguage(undefined), DEFAULT_LANGUAGE);
  assert.equal(pickLanguage(''), DEFAULT_LANGUAGE);
  // A language dropped from the registry must degrade, not throw.
  assert.equal(whisperLanguage('kl'), whisperLanguage(DEFAULT_LANGUAGE));
});

// --- thread count ------------------------------------------------------------

test('recognizerThreads leaves two cores for the IDE, clamped at both ends', () => {
  // Whisper decode time is dominated by thread count and plateaus past 12; below 2
  // it would be slower than speech. See voice-input.md for the measured table.
  assert.equal(recognizerThreads(32), 12);  // plateau
  assert.equal(recognizerThreads(14), 12);  // exactly the plateau
  assert.equal(recognizerThreads(10), 8);   // cpus - 2
  assert.equal(recognizerThreads(4), 2);    // floor
  assert.equal(recognizerThreads(1), 2);    // single core still gets the minimum
});

test('recognizerThreads survives a bogus cpu count', () => {
  // os.cpus() returns [] in some Linux containers.
  assert.equal(recognizerThreads(0), 2);
  assert.equal(recognizerThreads(undefined), 2);
  assert.equal(recognizerThreads(NaN), 2);
});

// --- transcript normalization ------------------------------------------------

test('normalizeTranscript trims, collapses whitespace and drops sound events', () => {
  assert.equal(normalizeTranscript('  hello   world  '), 'hello world');
  assert.equal(normalizeTranscript('[BLANK_AUDIO]'), '');
  assert.equal(normalizeTranscript('(music) run the tests'), 'run the tests');
  assert.equal(normalizeTranscript('*laughs* okay then'), 'okay then');
  assert.equal(normalizeTranscript('fix\nthe\tbug'), 'fix the bug');
});

test('normalizeTranscript drops sentence dots and commas but keeps them in numbers', () => {
  assert.equal(normalizeTranscript('Fix the bug, then run the tests.'), 'Fix the bug then run the tests');
  assert.equal(normalizeTranscript('Wait... really?'), 'Wait really?');
  assert.equal(normalizeTranscript('set it to 3.14 and 1,000'), 'set it to 3.14 and 1,000');
  assert.equal(normalizeTranscript('open src/main/stt.js'), 'open src/main/sttjs');
});

test('normalizeTranscript survives non-string input', () => {
  assert.equal(normalizeTranscript(undefined), '');
  assert.equal(normalizeTranscript(null), '');
  assert.equal(normalizeTranscript(42), '');
});

test('normalizeTranscript keeps non-Latin text intact', () => {
  assert.equal(normalizeTranscript('  şu dosyayı açar mısın  '), 'şu dosyayı açar mısın');
});

test('shouldEmit rejects empty and punctuation-only results', () => {
  assert.equal(shouldEmit(''), false);
  assert.equal(shouldEmit('   '), false);
  assert.equal(shouldEmit('...'), false);
  assert.equal(shouldEmit('?!'), false);
});

test('shouldEmit drops the phrases Whisper hallucinates on silence', () => {
  // These come back from VAD segments that caught a keystroke or a breath —
  // typing them into the session would be worse than dropping them.
  assert.equal(shouldEmit('Thank you.'), false);
  assert.equal(shouldEmit('thanks for watching'), false);
  assert.equal(shouldEmit('You'), false);
  assert.equal(shouldEmit('Okay.'), false);
  assert.equal(shouldEmit('Subtitles by the Amara.org community'), false);
});

test('shouldEmit keeps real dictation, including phrases containing a stock word', () => {
  assert.equal(shouldEmit('run the tests'), true);
  assert.equal(shouldEmit('thank you for the review, now fix it'), true);
  assert.equal(shouldEmit('okay now open the file'), true);
  assert.equal(shouldEmit('şu dosyayı açar mısın'), true);
});

// --- clips recorded on a paired phone ----------------------------------------

const {
  wavToSamples, resampleLinear, concatSamples, joinClipPhrases, SAMPLE_RATE, MAX_CLIP_SECONDS,
} = require('../src/main/stt-lib');

// A minimal RIFF/WAVE: fmt chunk + data chunk, PCM16 or Float32.
function wav({ rate = 16000, channels = 1, float = false, frames }) {
  const bits = float ? 32 : 16;
  const bytes = bits / 8;
  const data = Buffer.alloc(frames.length * channels * bytes);
  frames.forEach((frame, i) => {
    const values = Array.isArray(frame) ? frame : [frame];
    values.forEach((v, c) => {
      const off = (i * channels + c) * bytes;
      if (float) data.writeFloatLE(v, off); else data.writeInt16LE(Math.round(v * 32767), off);
    });
  });
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(float ? 3 : 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bytes, 16);
  fmt.writeUInt16LE(channels * bytes, 20);
  fmt.writeUInt16LE(bits, 22);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'ascii');
  dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dataHead, data]);
}

test('wavToSamples reads Android\'s 16 kHz mono PCM16 as-is', () => {
  const out = wavToSamples(wav({ frames: [0, 0.5, -0.5, 1] }));
  assert.strictEqual(out.length, 4);
  assert.ok(Math.abs(out[1] - 0.5) < 1e-3 && Math.abs(out[2] + 0.5) < 1e-3);
});

test('wavToSamples downmixes stereo and resamples Float32 48 kHz to 16 kHz', () => {
  const frames = Array.from({ length: 480 }, () => [0.2, 0.4]);
  const out = wavToSamples(wav({ rate: 48000, channels: 2, float: true, frames }));
  assert.strictEqual(out.length, 160);
  assert.ok(out.every((v) => Math.abs(v - 0.3) < 1e-6));
});

test('wavToSamples takes what is there when the data size was never patched', () => {
  const buf = wav({ frames: [0.1, 0.1, 0.1] });
  buf.writeUInt32LE(0, 40); // data chunk size → 0, as a recorder killed mid-write leaves it
  assert.strictEqual(wavToSamples(buf).length, 3);
});

test('wavToSamples rejects non-WAV input and unsupported encodings', () => {
  assert.throws(() => wavToSamples(Buffer.from('not audio at all')), /not a WAV/);
  const odd = wav({ frames: [0] });
  odd.writeUInt16LE(34, 34); // 34-bit samples
  assert.throws(() => wavToSamples(odd), /unsupported WAV/);
});

test('resampleLinear leaves matching rates untouched', () => {
  const s = new Float32Array([1, 2, 3]);
  assert.strictEqual(resampleLinear(s, SAMPLE_RATE, SAMPLE_RATE), s);
});

test('concatSamples joins clips in order', () => {
  assert.deepStrictEqual(Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([3])])), [1, 2, 3]);
});

test('joinClipPhrases drops hallucinations and empties like live dictation', () => {
  assert.strictEqual(joinClipPhrases(['Login hatasını düzelt.', ' Thank you. ', '', 'and add a test']),
    'Login hatasını düzelt and add a test');
  assert.strictEqual(joinClipPhrases([]), '');
});

test('a phone clip cap fits the relay frame in base64', () => {
  const base64Bytes = MAX_CLIP_SECONDS * SAMPLE_RATE * 2 * 4 / 3;
  assert.ok(base64Bytes < 12 * 1024 * 1024);
});

// --- GPU engine (whisper.cpp) ------------------------------------------------

test('the GPU engine is a macOS-only option', () => {
  assert.equal(gpuEngineSupported('darwin'), true);
  assert.equal(gpuEngineSupported('win32'), false);
  assert.equal(gpuEngineSupported('linux'), false);
});

test('gpuEngineFiles puts the server binary in bin/ and the ggml weights in ggml/', () => {
  const files = gpuEngineFiles('/r', 'turbo', path.posix.join);
  assert.equal(files.binary, `/r/bin/${GPU_ENGINE.binary}`);
  assert.equal(files.model, `/r/ggml/${MODELS[0].ggml.name}`);
  assert.equal(gpuEngineFiles('/r', 'nope', path.posix.join).model, null);
});

test('gpuEngineReady needs macOS, a binary and weights of the exact size', () => {
  const { binary, model } = gpuEngineFiles('/r', 'turbo', path.posix.join);
  const sizes = (map) => (f) => (f in map ? map[f] : null);
  const full = { [binary]: 8e6, [model]: MODELS[0].ggml.bytes };
  assert.equal(gpuEngineReady('/r', 'turbo', sizes(full), path.posix.join, 'darwin'), true);
  assert.equal(gpuEngineReady('/r', 'turbo', sizes(full), path.posix.join, 'win32'), false);
  assert.equal(gpuEngineReady('/r', 'turbo', sizes({ [model]: MODELS[0].ggml.bytes }), path.posix.join, 'darwin'), false);
  // A cut download must read as missing, not as a model that loads garbage.
  assert.equal(gpuEngineReady('/r', 'turbo', sizes({ ...full, [model]: 12345 }), path.posix.join, 'darwin'), false);
});

test('modelStates counts a model as ready when only the GPU engine has it', () => {
  const { binary, model } = gpuEngineFiles('/r', 'turbo', path.posix.join);
  const size = (f) => ({ [binary]: 8e6, [model]: MODELS[0].ggml.bytes })[f] ?? null;
  assert.equal(modelStates('/r', size, path.posix.join, 'darwin')[0].ready, true);
  assert.equal(modelStates('/r', size, path.posix.join, 'linux')[0].ready, false);
});

test('pickEngine prefers the GPU, falls back to the CPU, or reports none', () => {
  assert.equal(pickEngine({ gpuReady: true, cpuReady: true }), ENGINE_GPU);
  assert.equal(pickEngine({ gpuReady: false, cpuReady: true }), ENGINE_CPU);
  assert.equal(pickEngine({ gpuReady: false, cpuReady: false }), null);
});

test('whisperServerArgs binds loopback on the given port', () => {
  const args = whisperServerArgs({ model: '/m.bin', port: 4321 });
  assert.deepEqual(args.slice(0, 2), ['-m', '/m.bin']);
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '4321');
  assert.equal(args[args.indexOf('-t') + 1], String(GPU_ENGINE.threads));
});

test('serverLanguage turns Whisper detect into whisper.cpp auto', () => {
  assert.equal(serverLanguage(''), 'auto');
  assert.equal(serverLanguage('tr'), 'tr');
});

test('topLanguage picks the most likely code, or nothing', () => {
  assert.equal(topLanguage({ en: 0.12, ru: 0.27, tr: 0.19 }), 'ru');
  assert.equal(topLanguage(null), '');
  assert.equal(topLanguage({}), '');
});

test('the Turkish + English fence retries in the fenced language that scored higher', () => {
  // Measured: a fast mixed phrase detected as Russian, tr 0.19 vs en 0.12.
  assert.equal(pinnedRetryLanguage('en-tr', 'ru', { ru: 0.27, tr: 0.19, en: 0.12 }), 'tr');
  assert.equal(pinnedRetryLanguage('en-tr', 'de', { de: 0.5, en: 0.3, tr: 0.1 }), 'en');
  assert.equal(pinnedRetryLanguage('en-tr', 'tr', { tr: 0.9 }), null);
  assert.equal(pinnedRetryLanguage('en-tr', 'ru', {}), 'tr'); // no scores: the fixed fallback
});

test('the GPU engine waits longer for a pause and allows longer phrases', () => {
  assert.equal(vadConfigFor(ENGINE_CPU), VAD_CONFIG);
  assert.equal(vadConfigFor(null), VAD_CONFIG);
  assert.equal(vadConfigFor(ENGINE_GPU), GPU_VAD_CONFIG);
  assert.ok(GPU_VAD_CONFIG.minSilenceDuration > VAD_CONFIG.minSilenceDuration);
  assert.ok(GPU_VAD_CONFIG.maxSpeechDuration > VAD_CONFIG.maxSpeechDuration);
  assert.equal(GPU_VAD_CONFIG.windowSize, VAD_CONFIG.windowSize);
});

test('decodePrompt is the vocabulary plus the tail of what was said, cut at a word', () => {
  assert.equal(decodePrompt(''), VOCABULARY_PROMPT);
  assert.equal(decodePrompt('  bu  dosyayı aç '), `${VOCABULARY_PROMPT} bu dosyayı aç`);
  const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  const tail = decodePrompt(long).slice(VOCABULARY_PROMPT.length + 1);
  assert.ok(tail.length <= 200);
  assert.ok(long.endsWith(tail));
  assert.match(tail, /^word\d+ /); // starts on a whole word
});

test('a long run of the vocabulary sentence is dropped as an echo, real speech is kept', () => {
  const prompt = decodePrompt('earlier we said run the tests twice');
  assert.equal(shouldEmit("commit'le ve branch'i push et Then run lint and the tests", prompt), false);
  // The vocabulary is what this user really says: short runs of it must survive.
  assert.equal(shouldEmit('merge conflict varsa çöz', prompt), true);
  assert.equal(shouldEmit('Then run lint and the tests', prompt), true);
  assert.equal(shouldEmit('push', prompt), true);
  // The context tail is never an echo source: a phrase can be said twice.
  assert.equal(shouldEmit('earlier we said run the tests twice', prompt), true);
  // No prompt, no echo check.
  assert.equal(shouldEmit("commit'le ve branch'i push et Then run lint and the tests", ''), true);
  assert.equal(echoesPrompt('lint', prompt), false);
});

test('hasRepetitionLoop spots a word or short phrase repeated four times running', () => {
  assert.equal(hasRepetitionLoop('Pull request merge conflict march march march march march'), true);
  assert.equal(hasRepetitionLoop('fix it fix it fix it fix it'), true);
  assert.equal(hasRepetitionLoop('test test test'), false);
  assert.equal(hasRepetitionLoop('run the tests then run the build'), false);
  assert.equal(hasRepetitionLoop(''), false);
});

test('collapseRepetitions keeps one occurrence of each loop', () => {
  assert.equal(collapseRepetitions('merge conflict march march march march'), 'merge conflict march');
  assert.equal(collapseRepetitions('fix it fix it fix it and push'), 'fix it and push');
  assert.equal(collapseRepetitions('very very good'), 'very very good');
});

test('samplesToWav16 round-trips through wavToSamples', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const back = wavToSamples(samplesToWav16(samples));
  assert.equal(back.length, samples.length);
  for (let i = 0; i < samples.length; i++) assert.ok(Math.abs(back[i] - samples[i]) < 1e-3);
  // Out-of-range input is clamped, not wrapped.
  assert.ok(wavToSamples(samplesToWav16(new Float32Array([2])))[0] > 0.99);
});

test('joinClipPhrases drops a phrase that echoes the prompt it was decoded with', () => {
  assert.equal(joinClipPhrases([
    { text: 'bu dosyayı aç', prompt: VOCABULARY_PROMPT },
    { text: "Commit'le ve branch'i push et. Then run lint and the tests.", prompt: VOCABULARY_PROMPT },
    've kaydet',
  ]), 'bu dosyayı aç ve kaydet');
});

test('joinSegmentTexts glues mid-word segment splits back together', () => {
  const json = {
    text: ' Bu testlerini de gün\ncelle sonra\n branchı push et.\n',
    segments: [{ text: ' Bu testlerini de gün' }, { text: 'celle sonra' }, { text: ' branchı push et.' }],
  };
  assert.equal(normalizeTranscript(joinSegmentTexts(json)), 'Bu testlerini de güncelle sonra branchı push et');
  assert.equal(joinSegmentTexts({ text: ' only text' }), ' only text');
  assert.equal(joinSegmentTexts(null), '');
});

test('withSilence pads before and after, and leaves an unpadded input alone', () => {
  const s = new Float32Array([0.5, -0.5]);
  assert.deepEqual(Array.from(withSilence(s, 2, 1)), [0, 0, 0.5, -0.5, 0]);
  assert.equal(withSilence(s, 0, 0), s);
  assert.equal(withSilence(new Float32Array(0), 2, 2).length, 0);
  assert.ok(LEAD_PADDING_SECONDS > 0 && LEAD_PADDING_SECONDS < 0.5);
});
