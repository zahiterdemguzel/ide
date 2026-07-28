// Pure helpers behind the 3D viewer's animation bar. They read only duck-typed
// clip data (`{ name, duration, tracks: [{ times }] }`), so they're unit-testable
// without three.js — the Electron-free logic the viewer's chrome sits on.

const DEFAULT_FPS = 30;
export const MIN_FPS = 1;
export const MAX_FPS = 240;

// A glTF/FBX clip stores keyframe *times in seconds*, never an authoring frame
// rate — but a baked clip samples on a uniform grid, so the most common gap
// between consecutive keyframes is that grid. Take its mode across every track
// (mode, not min: a sparse hand-authored track would drag a minimum down) and
// invert it. Anything that doesn't land on a plausible rate falls back to 30,
// which only affects the number shown as "native" in the fps box.
export function detectFrameRate(clip, fallback = DEFAULT_FPS) {
  const counts = new Map();
  for (const track of (clip && clip.tracks) || []) {
    const times = track.times || [];
    for (let i = 1; i < times.length; i++) {
      // Rounded so float noise in exported times doesn't split one gap into many.
      const gap = Number((times[i] - times[i - 1]).toFixed(6));
      if (gap > 0) counts.set(gap, (counts.get(gap) || 0) + 1);
    }
  }
  let gap = 0, best = 0;
  for (const [value, n] of counts) {
    // Ties go to the shorter gap — the finer grid is the sampling one.
    if (n > best || (n === best && value < gap)) { gap = value; best = n; }
  }
  if (!gap) return fallback;
  const fps = Math.round(1 / gap);
  return fps >= MIN_FPS && fps <= MAX_FPS ? fps : fallback;
}

// One descriptor per clip for the picker: a label that's always unique (unnamed
// or duplicate-named clips are common in FBX exports, and the select needs to
// tell them apart), the detected native rate, and the frame count at that rate.
export function describeClips(clips) {
  const used = new Map();
  return (clips || []).map((clip, i) => {
    let label = (clip.name || '').trim() || `Clip ${i + 1}`;
    const seen = used.get(label) || 0;
    used.set(label, seen + 1);
    if (seen) label = `${label} (${seen + 1})`;
    const fps = detectFrameRate(clip);
    const duration = clip.duration || 0;
    return { clip, label, fps, duration, frames: Math.max(1, Math.round(duration * fps)) };
  });
}

// "12 / 72" — the playhead as a frame index at the *playback* rate, which is what
// the fps box changes. Frames are 0-based like every animation tool's timeline.
export function frameAt(time, fps, duration) {
  const last = Math.max(0, Math.round((duration || 0) * fps));
  return Math.min(last, Math.max(0, Math.round((time || 0) * fps)));
}

// Seconds → "1.20s", the readout beside the scrubber.
export function formatSeconds(time) {
  return `${Math.max(0, time || 0).toFixed(2)}s`;
}

// Playback rate the mixer runs at so a clip authored at `native` fps plays back
// at `target` fps. Guarded so a cleared/garbage fps box can't freeze the mixer.
export function timeScaleFor(target, native) {
  const to = Number(target), from = Number(native);
  if (!(to > 0) || !(from > 0)) return 1;
  return to / from;
}
