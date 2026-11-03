// Hold-to-talk on the New session button: hold it and say the task, let go and a
// session starts with what you said as its first message. The DOM and the mic live in
// src/renderer/voice.js; these are the decisions, kept DOM-free so they can be tested.

// How long a press must last before it becomes a microphone. Shorter, and an ordinary
// slow click would open the mic; longer, and the hold feels unresponsive.
export const HOLD_TO_TALK_MS = 400;
// A forgotten hold (a stuck mouse button, a dropped pointerup) must not record forever.
export const MAX_HOLD_MS = 2 * 60 * 1000;
// The capture target main is pointed at during a hold. Not a real session id, so a
// phrase captured for the hold can never be typed into a session terminal.
export const HOLD_TARGET = 'new-session-hold';

// Join a newly decoded phrase onto the running transcript. Whisper hands back one
// phrase per pause, already trimmed of sound events; blanks are ignored.
export function appendPhrase(transcript, phrase) {
  const next = (phrase || '').trim();
  if (!next) return transcript;
  return transcript ? `${transcript} ${next}` : next;
}

// What letting go does: a cancelled hold is dropped, a hold that caught no words says
// so instead of opening an empty session, anything else becomes the session's prompt.
export function holdOutcome(transcript, cancelled) {
  if (cancelled) return 'cancel';
  return (transcript || '').trim() ? 'create' : 'empty';
}
