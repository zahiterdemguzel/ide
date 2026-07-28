import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFrameRate, describeClips, frameAt, formatSeconds, timeScaleFor,
} from '../src/renderer/shared/anim-clips.js';

// Duck-typed clips: the helpers only read `name`, `duration` and `tracks[].times`.
const track = (times) => ({ times });
const sampled = (fps, seconds) => {
  const times = [];
  for (let i = 0; i * (1 / fps) <= seconds + 1e-9; i++) times.push(i / fps);
  return track(times);
};
const clip = (name, duration, tracks) => ({ name, duration, tracks });

test('detects the sampling rate of a uniformly baked track', () => {
  assert.equal(detectFrameRate(clip('walk', 2, [sampled(24, 2)])), 24);
  assert.equal(detectFrameRate(clip('run', 1, [sampled(60, 1)])), 60);
});

test('takes the mode across tracks, so a sparse track does not skew the rate', () => {
  const dense = sampled(30, 2);
  const sparse = track([0, 1, 2]); // one key per second
  assert.equal(detectFrameRate(clip('mix', 2, [dense, sparse])), 30);
});

test('ignores float noise in exported keyframe times', () => {
  const times = [0, 0.0416667, 0.0833333, 0.125, 0.1666667];
  assert.equal(detectFrameRate(clip('noisy', 0.17, [track(times)])), 24);
});

test('falls back to 30 without usable keyframe gaps', () => {
  assert.equal(detectFrameRate(clip('empty', 0, [])), 30);
  assert.equal(detectFrameRate(clip('single', 0, [track([0])])), 30);
  assert.equal(detectFrameRate(undefined), 30);
  assert.equal(detectFrameRate(clip('custom', 0, []), 12), 12);
});

test('falls back when the implied rate is implausible', () => {
  // 0.001s gaps → 1000 fps, past MAX_FPS
  assert.equal(detectFrameRate(clip('fast', 0.01, [sampled(1000, 0.01)])), 30);
  // a single 10s gap → 0.1 fps, under MIN_FPS
  assert.equal(detectFrameRate(clip('slow', 20, [track([0, 10, 20])])), 30);
});

test('describeClips labels, rates and counts frames', () => {
  const [walk] = describeClips([clip('Walk', 2, [sampled(24, 2)])]);
  assert.equal(walk.label, 'Walk');
  assert.equal(walk.fps, 24);
  assert.equal(walk.frames, 48);
});

test('describeClips gives unnamed and duplicate-named clips distinct labels', () => {
  const labels = describeClips([
    clip('', 1, []), clip('Take 001', 1, []), clip('Take 001', 1, []), clip('  ', 1, []),
  ]).map((c) => c.label);
  assert.deepEqual(labels, ['Clip 1', 'Take 001', 'Take 001 (2)', 'Clip 4']);
});

test('frameAt clamps to the clip and rounds to the playback grid', () => {
  assert.equal(frameAt(0, 24, 2), 0);
  assert.equal(frameAt(0.5, 24, 2), 12);
  assert.equal(frameAt(5, 24, 2), 48); // past the end → last frame
  assert.equal(frameAt(-1, 24, 2), 0);
});

test('formatSeconds renders two decimals and never a negative time', () => {
  assert.equal(formatSeconds(1.234), '1.23s');
  assert.equal(formatSeconds(0), '0.00s');
  assert.equal(formatSeconds(-3), '0.00s');
});

test('timeScaleFor is the target/native ratio, 1 for unusable input', () => {
  assert.equal(timeScaleFor(60, 30), 2);
  assert.equal(timeScaleFor(12, 24), 0.5);
  assert.equal(timeScaleFor(0, 24), 1);
  assert.equal(timeScaleFor(NaN, 24), 1);
  assert.equal(timeScaleFor(24, 0), 1);
});
