// Speaking a task to start a new session from the phone: from the home-screen
// widget (tap to start, tap again to send) or by holding New session in the app
// (let go to send). The recognizer is the phone's own (Android SpeechRecognizer via
// expo-speech-recognition); this file holds the decisions around it so they stay
// testable without a device.
// Plain JS rather than TypeScript so the node:test suite can import it — see
// test/mobile-voice-capture.test.mjs.

// The deep link the widget opens. The app's scheme is `ide` (app.json).
export const VOICE_LINK = 'ide://voice-session';

// How long New session must be held before it turns into a microphone — the
// desktop's HOLD_TO_TALK_MS, so the gesture feels the same on both.
export const HOLD_TO_TALK_MS = 400;

// Spoken languages offered on the listening sheet. Turkish first: it is the
// desktop's default spoken language too, and Google's Turkish model still copes
// with the English technical words a coding task is full of.
export const VOICE_LANGS = [
  { id: 'tr-TR', label: 'TR' },
  { id: 'en-US', label: 'EN' },
];
export const DEFAULT_VOICE_LANG = 'tr-TR';

/** @param {string | null | undefined} id */
export function knownVoiceLang(id) {
  return VOICE_LANGS.some((l) => l.id === id) ? /** @type {string} */ (id) : DEFAULT_VOICE_LANG;
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
