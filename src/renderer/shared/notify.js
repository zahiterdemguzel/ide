// Notification sound for the working → completed transition (see status-detection.md):
// when a session that was running finishes, the sidebar row animates and one of a
// few short chimes plays to pull the user's eye back. The sounds are synthesized
// with the Web Audio API rather than shipped as audio files — no binary asset, works
// offline under file://, and matches the app's pure-CSS/synth approach (the welcome
// watermark, the status dots). The chosen sound persists in localStorage.

const STORE_SOUND = 'ide.notifySound';
// Legacy on/off flag. The completion sound used to have a separate toggle; it's
// now the "None" entry in the picker. A stored "off" still resolves to silence.
const STORE_SOUND_ENABLED = 'ide.notifySoundEnabled';

// The selectable sounds. Each `notes` entry is one oscillator voice:
// { f: frequency Hz, t: start offset s, d: duration s, type, g: peak gain }.
// playTones() schedules them with a short attack + exponential decay so they read
// as a pluck/bell rather than a flat beep. `name` drives the settings combobox
// (kept plain like the theme names, which also aren't translated) — except the
// "None" sentinel, whose label is translated in settings.js. "None" has no notes,
// so playNotification('none') schedules nothing: it's a silent no-op, which is how
// the picker mutes the completion chime without a separate toggle.
export const SOUNDS = [
  { id: 'none', name: 'None', notes: [] },
  {
    id: 'chime',
    name: 'Chime',
    notes: [
      { f: 783.99, t: 0, d: 0.5, type: 'sine', g: 0.5 }, // G5
      { f: 1046.5, t: 0.11, d: 0.6, type: 'sine', g: 0.5 }, // C6
    ],
  },
  {
    id: 'ping',
    name: 'Ping',
    notes: [
      { f: 1318.5, t: 0, d: 0.35, type: 'triangle', g: 0.55 }, // E6
    ],
  },
  {
    id: 'marimba',
    name: 'Marimba',
    notes: [
      { f: 523.25, t: 0, d: 0.4, type: 'sine', g: 0.5 }, // C5
      { f: 659.25, t: 0.08, d: 0.4, type: 'sine', g: 0.45 }, // E5
      { f: 783.99, t: 0.16, d: 0.5, type: 'sine', g: 0.4 }, // G5
    ],
  },
  {
    id: 'bell',
    name: 'Bell',
    notes: [
      { f: 880, t: 0, d: 0.9, type: 'sine', g: 0.4 }, // A5 fundamental
      { f: 1760, t: 0, d: 0.7, type: 'sine', g: 0.18 }, // +octave shimmer
      { f: 2637, t: 0, d: 0.5, type: 'sine', g: 0.08 }, // high partial
    ],
  },
];

const DEFAULT_SOUND = 'chime';

export function getSound() {
  // Honour the legacy off-toggle: a previously muted chime maps to "None".
  if (localStorage.getItem(STORE_SOUND_ENABLED) === 'false') return 'none';
  const id = localStorage.getItem(STORE_SOUND);
  return SOUNDS.some((s) => s.id === id) ? id : DEFAULT_SOUND;
}

export function setSound(id) {
  if (!SOUNDS.some((s) => s.id === id)) return;
  localStorage.setItem(STORE_SOUND, id);
  // The picker now owns on/off, so drop the stale legacy flag once the user picks.
  localStorage.removeItem(STORE_SOUND_ENABLED);
}

// Pure trigger test, unit-tested: the chime+animation fire only when a session that
// was actively working settles into "completed" (a finished response / PTY exit) —
// not on needs-input, and not on any state that was already settled.
export function isCompletionTransition(prev, next) {
  return prev === 'working' && next === 'completed';
}

// One shared AudioContext, created lazily on the first play (a context built before
// any user gesture can start suspended) and resumed each time, so the sound survives
// the browser autoplay policy.
let audioCtx = null;

function playTones(notes) {
  if (typeof AudioContext === 'undefined') return;
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const now = audioCtx.currentTime;
  for (const n of notes) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = n.type;
    osc.frequency.value = n.f;
    const start = now + n.t;
    // Fast attack, exponential decay to (near) silence — a pluck/bell envelope.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(n.g, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + n.d + 0.05);
  }
}

// Play a sound by id, defaulting to the user's saved choice.
export function playNotification(id = getSound()) {
  const sound = SOUNDS.find((s) => s.id === id);
  if (sound) playTones(sound.notes);
}
