// The one voice capture the app can be running, shared by everything that can drive
// it: the home-screen widget's deep link, holding New session, and the listening
// sheet's own buttons. The sheet (components/VoiceSheet.tsx) owns the recognizer and
// reacts to these requests; callers only ask.
import * as SecureStore from 'expo-secure-store';
import { storageKey } from './storage';
import { knownVoiceLang } from '../lib/voice-capture';

// 'widget' captures run until tapped again; 'hold' ones until the finger lifts.
export type VoiceSource = 'widget' | 'hold';
// 'toggle' is the widget's tap: start when idle, send when listening — only the
// sheet knows which, so the deep-link handler just forwards the tap.
export type VoiceRequest =
  | { kind: 'start'; source: VoiceSource } | { kind: 'toggle' } | { kind: 'finish' } | { kind: 'cancel' };

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

const KEY_LANG = storageKey('voiceLang');

export async function getVoiceLang(): Promise<string> {
  try {
    return knownVoiceLang(await SecureStore.getItemAsync(KEY_LANG));
  } catch {
    return knownVoiceLang(null);
  }
}

export async function setVoiceLang(id: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY_LANG, knownVoiceLang(id));
  } catch {
    // Only the sticky choice is lost; the capture itself still uses `id`.
  }
}
