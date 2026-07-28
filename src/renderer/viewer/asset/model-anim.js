import * as THREE from 'three';
import {
  describeClips, frameAt, formatSeconds, timeScaleFor, MIN_FPS, MAX_FPS,
} from '../../shared/anim-clips.js';

// Animation playback for the 3D model views. A model that carries clips (glTF's
// `animations`, an FBX's takes — normalised onto the root's `.animations` by
// model-scene.js's loadModel) gets a transport bar pinned to the bottom of the
// viewport: clip picker, play/pause, scrubber, loop, and a frame-rate box.
//
// The fps box is the point of the whole thing: a clip stores keyframe *times*,
// not a rate, so "play at 12 fps" means running the mixer at
// target/native — the clip's detected native rate is the box's default, and any
// other value is just a timeScale. Both the read-only viewer and the editor
// mount the same bar, so playback looks and behaves identically in each.
//
// Returns null when the model has no clips (no bar, nothing to clean up).
// Otherwise `{ dispose, rest }` — `rest()` pauses and restores the authored pose,
// which the editor calls before exporting so a mid-animation pose is never saved.
export function createAnimationBar(root, wrap, addUpdate) {
  const clips = describeClips(root.animations);
  if (!clips.length) return null;

  const mixer = new THREE.AnimationMixer(root);

  let entry = clips[0];
  let action = null; // null between rest() and the next play/scrub
  let restPose = null; // pose snapshot taken when an action binds, undone by rest()
  let playing = false;
  let scrubbing = false;
  let fps = entry.fps;

  // --- transport bar ---
  const bar = document.createElement('div');
  bar.className = 'model-anim-bar';

  const play = document.createElement('button');
  play.className = 'model-anim-play';
  bar.appendChild(play);

  // A single-clip model has nothing to pick — show its name, not a dead dropdown.
  let picker = null;
  if (clips.length === 1) {
    const name = document.createElement('span');
    name.className = 'model-anim-name';
    name.textContent = name.title = clips[0].label;
    bar.appendChild(name);
  } else {
    picker = document.createElement('select');
    picker.className = 'model-anim-clip';
    picker.title = 'Animation clip';
    clips.forEach((c, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = c.label;
      picker.appendChild(opt);
    });
    picker.addEventListener('change', () => selectClip(Number(picker.value)));
    bar.appendChild(picker);
  }

  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.className = 'model-anim-scrub';
  scrub.min = '0';
  scrub.step = 'any';
  scrub.title = 'Scrub';
  bar.appendChild(scrub);

  const time = document.createElement('span');
  time.className = 'model-anim-time';
  bar.appendChild(time);

  const loop = document.createElement('button');
  loop.className = 'model-anim-loop on';
  loop.textContent = '⟳';
  loop.title = 'Loop';
  let looping = true;
  bar.appendChild(loop);

  const rate = document.createElement('label');
  rate.className = 'model-anim-rate';
  const fpsInput = document.createElement('input');
  fpsInput.type = 'number';
  fpsInput.min = String(MIN_FPS);
  fpsInput.max = String(MAX_FPS);
  fpsInput.step = '1';
  fpsInput.className = 'model-anim-fps';
  rate.append(fpsInput, Object.assign(document.createElement('span'), { textContent: 'fps' }));
  bar.appendChild(rate);

  // --- playback ---
  const setPlaying = (on) => {
    playing = on;
    if (action) action.paused = !on;
    play.textContent = on ? '❚❚' : '▶';
    play.title = on ? 'Pause' : 'Play';
    play.classList.toggle('on', on);
  };

  const applyRate = () => { mixer.timeScale = timeScaleFor(fps, entry.fps); };

  const setFps = (value) => {
    fps = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(Number(value) || entry.fps)));
    fpsInput.value = String(fps);
    fpsInput.title = `Playback rate — "${entry.label}" was authored at ${entry.fps} fps`;
    applyRate();
    refresh();
  };

  // An action is only bound while the transport is in use: rest() drops it so the
  // mixer stops writing to the graph entirely, and the next play/scrub rebinds.
  // The pose is snapshotted at bind time, not at load, so an edit made while the
  // transport is stopped survives the next play → rest round-trip.
  const ensureAction = () => {
    if (action) return action;
    restPose = captureRestPose(root);
    action = mixer.clipAction(entry.clip);
    action.clampWhenFinished = true;
    action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.reset();
    action.play();
    action.paused = !playing;
    return action;
  };

  // Unbinding also undoes the pose: a mixer only writes the channels its clips
  // touch, so merely stopping it would leave the last evaluated frame in place —
  // and the next bind would then snapshot *that* as the authored pose.
  const dropAction = () => {
    if (!action) return;
    action.stop();
    mixer.uncacheAction(entry.clip, root);
    action = null;
    if (restPose) { restPose(); restPose = null; }
  };

  const selectClip = (i) => {
    dropAction();
    entry = clips[i];
    scrub.max = String(entry.duration || 0);
    ensureAction();
    setFps(entry.fps); // each clip's own native rate is the sane default
  };

  // The readout counts frames at the *playback* rate, so it stays in step with
  // whatever the fps box says rather than with the clip's authored grid.
  const refresh = () => {
    const t = action ? action.time : 0;
    if (!scrubbing) scrub.value = String(t);
    const total = frameAt(entry.duration, fps, entry.duration);
    time.textContent = `${formatSeconds(t)} · ${frameAt(t, fps, entry.duration)}/${total}`;
    time.title = `${formatSeconds(entry.duration)} at ${fps} fps (authored ${entry.fps} fps)`;
  };

  const seek = (t) => {
    ensureAction().time = Math.min(entry.duration, Math.max(0, t));
    mixer.update(0); // re-evaluate the pose at the new time without advancing it
    refresh();
  };

  play.addEventListener('click', () => {
    const a = ensureAction();
    // Replaying a finished one-shot should start over, not sit on the last frame.
    if (!playing && !looping && a.time >= entry.duration) seek(0);
    setPlaying(!playing);
  });
  loop.addEventListener('click', () => {
    looping = !looping;
    loop.classList.toggle('on', looping);
    if (action) action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  });
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => { scrubbing = true; seek(Number(scrub.value)); });
  scrub.addEventListener('change', () => { scrubbing = false; seek(Number(scrub.value)); });
  fpsInput.addEventListener('change', () => setFps(fpsInput.value));

  // A one-shot that runs out stops the transport rather than leaving it "playing"
  // on a frozen last frame.
  const onFinished = () => setPlaying(false);
  mixer.addEventListener('finished', onFinished);

  const stopUpdate = addUpdate((delta) => {
    mixer.update(delta);
    if (playing) refresh();
  });

  selectClip(0);
  setPlaying(true);
  wrap.appendChild(bar);

  return {
    // Pause and put the model back in its authored pose. The editor calls this
    // before exporting (the exporter serialises the live graph, so a playing
    // clip would otherwise bake the showing frame in) and whenever a gizmo drag
    // starts (the mixer would overwrite the edit on the next frame).
    rest() {
      setPlaying(false);
      dropAction();
      refresh();
    },
    dispose() {
      stopUpdate();
      mixer.removeEventListener('finished', onFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      bar.remove();
    },
  };
}

// Snapshot every local transform (and morph weights) in the graph, returning the
// function that puts them all back — how playback is undone exactly.
function captureRestPose(root) {
  const nodes = [];
  root.traverse((o) => {
    nodes.push({
      obj: o,
      position: o.position.clone(),
      quaternion: o.quaternion.clone(),
      scale: o.scale.clone(),
      morph: o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null,
    });
  });
  return () => {
    for (const n of nodes) {
      n.obj.position.copy(n.position);
      n.obj.quaternion.copy(n.quaternion);
      n.obj.scale.copy(n.scale);
      if (n.morph && n.obj.morphTargetInfluences) {
        for (let i = 0; i < n.morph.length; i++) n.obj.morphTargetInfluences[i] = n.morph[i];
      }
    }
  };
}
