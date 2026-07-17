// Video view: a custom player (no native <video controls>) matching the audio
// player's transport — circular play button, scrubbable progress bar with a time
// bubble, speed / mute / volume, plus fullscreen.
//
// Unlike every other asset the viewer opens, the bytes are NOT read over IPC: the
// <video> is pointed at a file:// URL so Chromium streams it with range requests.
// A base64 data URL of a multi-hundred-MB clip would be copied through IPC and
// held in memory whole.
//
// `body` is the asset view's body container; `registerCleanup` lets the asset
// coordinator stop our animation loop when another asset opens (clearing the body
// removes the <video>, which stops playback).

const SPEEDS = [1, 1.5, 2, 0.5];

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
};

export function renderVideo(url, ext, body, registerCleanup) {
  const el = buildPlayer();
  body.appendChild(el.root);
  el.video.src = url;

  let raf = 0;

  const paint = () => {
    const dur = el.video.duration || 0;
    const frac = dur ? el.video.currentTime / dur : 0;
    el.fill.style.width = (frac * 100) + '%';
    el.cur.textContent = fmt(el.video.currentTime);
  };
  const tick = () => {
    paint();
    if (!el.video.paused && !el.video.ended) raf = requestAnimationFrame(tick);
  };

  const seek = (clientX) => {
    const rect = el.bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (el.video.duration) el.video.currentTime = frac * el.video.duration;
    paint();
  };

  const toggle = () => { el.video.paused ? el.video.play() : el.video.pause(); };
  el.play.onclick = toggle;
  el.video.onclick = toggle;
  el.video.onplay = () => { el.root.classList.add('playing'); tick(); };
  el.video.onpause = () => { el.root.classList.remove('playing'); };
  el.video.onended = () => { el.root.classList.remove('playing'); paint(); };
  el.video.ontimeupdate = paint;   // covers seeking while paused
  el.video.onloadedmetadata = () => {
    el.dur.textContent = fmt(el.video.duration);
    el.meta.textContent = `${el.video.videoWidth}×${el.video.videoHeight}`;
    paint();
  };
  // A container Chromium can't demux (.avi/.wmv/.flv/…) or a codec it lacks fails
  // here rather than at load, so the message points at the format, not the file.
  el.video.onerror = () => {
    el.stage.classList.add('vp-stage-err');
    el.stage.textContent = `Cannot play this ${ext.toUpperCase()} — the container or codec isn't supported. Use "Open externally".`;
    el.controls.style.display = 'none';
  };

  let dragging = false;
  el.bar.onpointerdown = (e) => { dragging = true; el.bar.setPointerCapture(e.pointerId); seek(e.clientX); };
  el.bar.onpointermove = (e) => {
    const rect = el.bar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frac = Math.min(1, Math.max(0, x / rect.width));
    el.tip.textContent = fmt(frac * (el.video.duration || 0));
    el.tip.style.left = x + 'px';
    el.tip.classList.add('on');
    if (dragging) seek(e.clientX);
  };
  el.bar.onpointerup = () => { dragging = false; };
  el.bar.onpointerleave = () => { el.tip.classList.remove('on'); };

  let speedIdx = 0;
  el.speed.onclick = () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    el.video.playbackRate = SPEEDS[speedIdx];
    el.speed.textContent = SPEEDS[speedIdx] + '×';
  };

  const updateVolIcon = () => {
    const v = el.video.muted ? 0 : el.video.volume;
    el.mute.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    el.mute.classList.toggle('muted', v === 0);
  };
  el.vol.oninput = () => { el.video.volume = +el.vol.value; el.video.muted = false; updateVolIcon(); };
  el.mute.onclick = () => { el.video.muted = !el.video.muted; updateVolIcon(); };

  // Fullscreen the stage, not the <video>, so the custom controls come along.
  el.full.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.root.requestFullscreen().catch(() => {});
  };

  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') el.video.currentTime += 5;
    else if (e.key === 'ArrowLeft') el.video.currentTime -= 5;
    else return;
    paint();
  };
  el.root.tabIndex = 0;
  el.root.addEventListener('keydown', onKey);

  registerCleanup && registerCleanup(() => {
    cancelAnimationFrame(raf);
    el.video.pause();
    if (document.fullscreenElement === el.root) document.exitFullscreen();
  });
}

function buildPlayer() {
  const root = document.createElement('div');
  root.className = 'video-player';
  root.innerHTML = `
    <div class="vp-stage"><video class="vp-video" playsinline></video></div>
    <div class="vp-bar-wrap">
      <div class="vp-bar"><div class="vp-fill"></div></div>
      <span class="vp-tip"></span>
    </div>
    <div class="vp-controls">
      <button class="vp-play" title="Play / Pause" aria-label="Play">
        <svg class="vp-ico-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg class="vp-ico-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <span class="vp-time"><span class="vp-cur">0:00</span> / <span class="vp-dur">0:00</span></span>
      <span class="vp-meta"></span>
      <span class="vp-spacer"></span>
      <button class="vp-speed" title="Playback speed">1×</button>
      <button class="vp-mute" title="Mute">🔊</button>
      <input class="vp-vol" type="range" min="0" max="1" step="0.05" value="1" title="Volume">
      <button class="vp-full" title="Fullscreen">⛶</button>
    </div>`;
  const $ = (s) => root.querySelector(s);
  return {
    root, stage: $('.vp-stage'), video: $('.vp-video'),
    bar: $('.vp-bar'), fill: $('.vp-fill'), tip: $('.vp-tip'),
    controls: $('.vp-controls'), play: $('.vp-play'), cur: $('.vp-cur'), dur: $('.vp-dur'),
    meta: $('.vp-meta'), speed: $('.vp-speed'), mute: $('.vp-mute'),
    vol: $('.vp-vol'), full: $('.vp-full'),
  };
}
