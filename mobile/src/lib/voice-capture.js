// Speaking a task to start a new session from the phone: from the home-screen
// widget (tap to start, tap again to send) or by holding New session in the app
// (let go to send). Two recognizers take part: the phone's own (Android
// SpeechRecognizer via expo-speech-recognition) draws the live preview, and the
// clip it records goes to the paired desktop's Whisper for the transcript that is
// actually sent — the phone's recognizer handles one language per capture and
// mangles Turkish + English, which the desktop's is tuned for. This file holds the
// decisions around both so they stay testable without a device.
// Plain JS rather than TypeScript so the node:test suite can import it — see
// test/mobile-voice-capture.test.mjs.

// The deep link the widget opens. The app's scheme is `ide` (app.json).
export const VOICE_LINK = 'ide://voice-session';

// How long New session must be held before the listening sheet shows. Shorter than
// the desktop's 400 ms because nothing waits on it: the microphone already opened
// when the finger went down (see canArmSilently), so this only tells a hold from a
// tap — and a tap is well under 250 ms.
export const HOLD_TO_TALK_MS = 250;

// The spoken-language chip on the listening sheet. `recognizer` is the locale the
// phone's live preview runs in; `whisper` is the desktop's LANGUAGES id
// (src/main/stt-lib.js) the recorded clip is transcribed with. TR+EN is the
// desktop's default fenced auto-detect, so a sentence can switch language midway.
// Its preview runs in Turkish, biased toward the English words a coding task is
// full of (CODING_TERMS); the final text comes from Whisper either way.
export const VOICE_LANGS = [
  { id: 'auto', label: 'TR+EN', recognizer: 'tr-TR', whisper: 'en-tr' },
  { id: 'tr', label: 'TR', recognizer: 'tr-TR', whisper: 'tr' },
  { id: 'en', label: 'EN', recognizer: 'en-US', whisper: 'en' },
];
export const DEFAULT_VOICE_LANG = 'auto';

/** @param {string | null | undefined} id */
export function knownVoiceLang(id) {
  return VOICE_LANGS.some((l) => l.id === id) ? /** @type {string} */ (id) : DEFAULT_VOICE_LANG;
}

/** @param {string | null | undefined} id */
export function voiceLang(id) {
  return /** @type {typeof VOICE_LANGS[number]} */ (VOICE_LANGS.find((l) => l.id === knownVoiceLang(id)));
}

// English words a Turkish-locale preview would otherwise spell phonetically
// ("komit", "rifaktır"). Android 13+ biases toward them (EXTRA_BIASING_STRINGS).
export const CODING_TERMS = [
  'Claude', 'commit', 'push', 'pull request', 'merge', 'branch', 'rebase', 'refactor', 'bug', 'fix',
  'test', 'unit test', 'lint', 'build', 'deploy', 'API', 'endpoint', 'component', 'function', 'class',
  'TypeScript', 'JavaScript', 'React', 'Electron', 'Android', 'mobile', 'widget', 'session', 'terminal',
  'README', 'config', 'database', 'error', 'log', 'debug', 'performance', 'UI', 'login',
];

/**
 * May the microphone open the instant New session is pressed, before we know it is
 * a hold? Only when nothing else is showing and the permission is already granted:
 * a tap must never pop a permission prompt, so a first-ever hold asks at the
 * threshold instead.
 * @param {string} phase
 * @param {boolean} micGranted
 */
export function canArmSilently(phase, micGranted) {
  return micGranted && (phase === 'idle' || phase === 'error');
}

/**
 * The prompt to send: the desktop's Whisper transcript when it produced one, else the
 * phone's own (an older desktop, no voice model installed, a timeout, Android < 13
 * with nothing recorded).
 * @param {{ text?: string, error?: string } | null | undefined} desktop
 * @param {string} device
 */
export function pickFinalTranscript(desktop, device) {
  const whisper = typeof desktop?.text === 'string' ? desktop.text.trim() : '';
  return whisper || device.trim();
}

/** @param {string | null | undefined} url */
export function isVoiceLink(url) {
  return typeof url === 'string' && /^ide:\/\/voice-session(?:[/?#]|$)/i.test(url);
}

/**
 * What a widget tap means given where the capture is: the first tap starts
 * listening, the second sends what was heard, and a tap while the session is being
 * created is ignored rather than starting a second capture over it.
 * @param {'idle' | 'listening' | 'finishing' | 'sending' | 'error'} phase
 * @returns {'start' | 'finish' | 'ignore'}
 */
export function voiceLinkAction(phase) {
  if (phase === 'listening') return 'finish';
  if (phase === 'idle' || phase === 'error') return 'start';
  return 'ignore';
}

/**
 * @typedef {{ finals: string[], interim: string }} Transcript
 * Finished phrases in order, plus the phrase still being heard.
 */

/** @returns {Transcript} */
export function emptyTranscript() {
  return { finals: [], interim: '' };
}

/**
 * Fold one recognizer result in. In continuous mode Android reports each phrase as
 * it forms (interim) and then once more as final, after which the next phrase
 * starts from nothing — so a final is appended and an interim only replaces the
 * phrase in progress.
 * @param {Transcript} t
 * @param {{ transcript?: string, isFinal?: boolean }} result
 * @returns {Transcript}
 */
export function foldResult(t, { transcript = '', isFinal = false }) {
  const phrase = transcript.trim();
  if (!isFinal) return { finals: t.finals, interim: phrase };
  return { finals: phrase ? [...t.finals, phrase] : t.finals, interim: '' };
}

/**
 * Everything heard so far as one prompt. The interim phrase counts: a stop that
 * lands before the recognizer finalizes the last phrase must not drop it.
 * @param {Transcript} t
 */
export function transcriptText(t) {
  return [...t.finals, t.interim].join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The recognizer ended on its own. Before Android 13 there is no continuous mode,
 * so it stops at the first pause; while the user is still talking we restart it
 * and keep appending, which is what makes "tap again to send" work there.
 * @param {string} phase
 */
export function shouldRestartOnEnd(phase) {
  return phase === 'listening';
}

// Errors that only mean "nothing was said yet" — keep listening instead of failing.
const QUIET_ERRORS = new Set(['no-speech', 'speech-timeout']);

/**
 * @param {string} code expo-speech-recognition's error code
 * @param {string} phase
 * @returns {'restart' | 'fail' | 'ignore'}
 */
export function recognitionErrorAction(code, phase) {
  // stop()/abort() on Android reports a trailing "aborted"/"no-speech" — not a
  // failure. Switching language mid-capture aborts on purpose, while still listening.
  if (phase !== 'listening' || code === 'aborted') return 'ignore';
  if (QUIET_ERRORS.has(code)) return 'restart';
  return 'fail';
}

/** @param {string} code */
export function recognitionErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
      return 'Microphone access is off for IDE Remote. Allow it in the phone’s settings to speak a task.';
    case 'service-not-allowed':
    case 'language-not-supported':
      return 'This phone has no speech recognizer for that language. Install Google’s speech services, or switch the language.';
    case 'network':
      return 'Speech recognition needs a connection for this language. Check the network, or download the offline language pack.';
    case 'audio-capture':
    case 'busy':
      return 'The microphone is in use by another app.';
    default:
      return 'Speech recognition stopped unexpectedly. Try again.';
  }
}
