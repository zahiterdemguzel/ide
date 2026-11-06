// The one voice capture the app can be running, shared by everything that can drive
// it: the home-screen widget's deep link, holding New session, and the listening
// sheet's own buttons. The sheet (components/VoiceSheet.tsx) owns the recognizer and
// reacts to these requests; callers only ask.

// 'widget' captures run until tapped again; 'hold' ones until the finger lifts.
export type VoiceSource = 'widget' | 'hold';
// 'toggle' is the widget's tap: start when idle, send when listening — only the
// sheet knows which, so the deep-link handler just forwards the tap.
// 'arm' / 'reveal' / 'disarm' are New session's press, hold threshold and early
// release: the mic opens unseen on the press so the first word isn't lost to the
// recognizer's start-up, shows itself once it's a hold, and is dropped on a tap.
export type VoiceRequest =
  | { kind: 'start'; source: VoiceSource } | { kind: 'toggle' } | { kind: 'finish' } | { kind: 'cancel' }
  | { kind: 'arm' } | { kind: 'reveal' } | { kind: 'disarm' }
  // The held finger's horizontal travel since the press, for the slide-to-cancel hint.
  | { kind: 'slide'; dx: number };

const listeners = new Set<(r: VoiceRequest) => void>();

export function onVoiceRequest(fn: (r: VoiceRequest) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const request = (r: VoiceRequest) => listeners.forEach((fn) => fn(r));
export const startVoice = (source: VoiceSource) => request({ kind: 'start', source });
export const toggleVoice = () => request({ kind: 'toggle' });
export const finishVoice = () => request({ kind: 'finish' });
export const cancelVoice = () => request({ kind: 'cancel' });
export const armVoice = () => request({ kind: 'arm' });
export const revealVoice = () => request({ kind: 'reveal' });
export const disarmVoice = () => request({ kind: 'disarm' });
export const slideVoice = (dx: number) => request({ kind: 'slide', dx });
