// The GPU speech engine: a whisper.cpp `whisper-server` sidecar (Metal on macOS)
// that stt.js hands each VAD phrase to over loopback HTTP. One process per app
// instance, on a port picked free at start, so several instances never collide.
// It is started on the first warm/arm, restarted on the next decode if it dies, and
// killed by stop() (voice input switched off, idle release, quit).
//
// Electron-free on purpose: the pure parts (args, WAV encoding, language picking)
// live in stt-lib.js; this file is only the process + HTTP plumbing.

const { spawn } = require('child_process');
const net = require('net');
const { whisperServerArgs, samplesToWav16, topLanguage, joinSegmentTexts } = require('./stt-lib');

// The very first launch on a machine compiles the embedded Metal shaders (~15 s on an
// M3 Max; later launches take ~1 s because macOS caches them), so readiness waits long.
const READY_TIMEOUT_MS = 90 * 1000;
const READY_POLL_MS = 150;
const STDERR_TAIL_CHARS = 2000;
// A phrase is at most 20 s of audio and decodes in about a second; 30 s means stuck.
const DECODE_TIMEOUT_MS = 30 * 1000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilServing(port, isAlive) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive()) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await delay(READY_POLL_MS);
  }
  throw new Error('the GPU speech engine did not start in time');
}

function createGpuEngine({ binary, model }) {
  let child = null;
  let port = null;
  let starting = null;
  let stderrTail = '';

  function launch() {
    return new Promise((resolve, reject) => {
      freePort().then((picked) => {
        port = picked;
        const proc = spawn(binary, whisperServerArgs({ model, port }), { stdio: ['ignore', 'ignore', 'pipe'] });
        child = proc;
        let exited = false;
        const failed = (why) => {
          exited = true;
          if (child === proc) { child = null; starting = null; }
          reject(new Error(`the GPU speech engine stopped: ${why}${stderrTail ? ` — ${stderrTail.trim().split('\n').pop()}` : ''}`));
        };
        proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS); });
        proc.once('error', (err) => failed(err.message));
        proc.once('exit', (code, signal) => failed(signal || `exit ${code}`));
        waitUntilServing(port, () => !exited).then(() => { if (!exited) resolve(); }, reject);
      }, reject);
    });
  }

  // Deduped like the CPU recognizer's load: warm and the first arm share one start.
  function start() {
    if (child && !starting) return Promise.resolve();
    if (!starting) {
      starting = launch().then(() => { starting = null; }, (err) => { stop(); throw err; });
    }
    return starting;
  }

  // One phrase. `language` is a Whisper code or 'auto'. Resolves { text, lang,
  // probabilities }: `lang` is the pinned code, or the most likely one when detecting.
  async function decode(samples, language, prompt) {
    await start();
    const form = new FormData();
    form.append('file', new Blob([samplesToWav16(samples)], { type: 'audio/wav' }), 'phrase.wav');
    form.append('response_format', 'verbose_json');
    form.append('language', language);
    form.append('temperature', '0');
    // Timestamps stay on even though they split a phrase into segments, sometimes
    // mid-word: measured, `no_timestamps` made a 12 s phrase come back as only its
    // last sentence. See joinSegmentTexts for the mid-word splits.
    if (prompt) form.append('prompt', prompt);
    let json;
    try {
      // Bounded: decodes run one at a time, so a stalled sidecar would otherwise hold
      // every later phrase (and a New session hold's release) forever.
      const res = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(DECODE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`the GPU speech engine answered HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      // Whatever went wrong, the next phrase gets a fresh sidecar.
      stop();
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('the GPU speech engine stopped responding');
      }
      throw err;
    }
    if (json && json.error) throw new Error(`the GPU speech engine failed: ${json.error}`);
    const probabilities = (json && json.language_probabilities) || null;
    const lang = language && language !== 'auto' ? language : topLanguage(probabilities);
    return { text: joinSegmentTexts(json), lang, probabilities };
  }

  function stop() {
    const proc = child;
    child = null;
    starting = null;
    if (proc && proc.exitCode === null) proc.kill();
  }

  return { start, decode, stop };
}

module.exports = { createGpuEngine };
