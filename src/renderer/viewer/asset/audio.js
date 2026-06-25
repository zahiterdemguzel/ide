// Audio view: a fully custom player (no native <audio controls>) — a circular
// transport button plus an interactive, mirrored bar waveform decoded from
// AudioContext.decodeAudioData (base64 → ArrayBuffer, no network). Clicking or
// dragging the waveform seeks; hovering previews the time under the cursor.
// `body` is the asset view's body container; `registerCleanup` lets the asset
// coordinator stop our animation loop / ResizeObserver when another asset opens
// (the bare <audio> still drives playback, so clearing the body also stops it).
let audioCtx;

const BAR = 3, GAP = 2;            // waveform bar width + gap, CSS px
const SPEEDS = [1, 1.5, 2, 0.5];  // cycled by the speed button

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
};

export function renderAudio(dataUrl, base64, body, registerCleanup) {
  const el = buildPlayer();
  body.appendChild(el.root);
  el.audio.src = dataUrl;

  const colors = readColors();
  let buffer = null;     // decoded AudioBuffer (for recomputing peaks on resize)
  let peaks = [];        // one 0..1 amplitude per visible bar
  let hoverX = -1;       // cursor x within the wave while hovering, else -1
  let raf = 0;

  // --- waveform geometry & painting ---
  function relayout() {
    const cssW = el.waveWrap.clientWidth, cssH = el.waveWrap.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    el.canvas.width = Math.round(cssW * dpr);
    el.canvas.height = Math.round(cssH * dpr);
    el.canvas.style.width = cssW + 'px';
    el.canvas.style.height = cssH + 'px';
    el.ctx = el.canvas.getContext('2d');
    el.ctx.scale(dpr, dpr);
    el.cssW = cssW; el.cssH = cssH;
    if (buffer) peaks = computePeaks(buffer, Math.floor(cssW / (BAR + GAP)));
    draw();
  }

  // The played fraction colours bars left of the playhead; hovering brightens
  // the column under the cursor so click-to-seek feels physical.
  function draw() {
    const ctx = el.ctx; if (!ctx) return;
    const W = el.cssW, H = el.cssH, mid = H / 2;
    const dur = el.audio.duration || 0;
    const played = dur ? el.audio.currentTime / dur : 0;
    ctx.clearRect(0, 0, W, H);

    const playedGrad = ctx.createLinearGradient(0, 0, 0, H);
    playedGrad.addColorStop(0, colors.accentHi);
    playedGrad.addColorStop(1, colors.accent);

    for (let i = 0; i < peaks.length; i++) {
      const x = i * (BAR + GAP);
      const frac = (i + 0.5) / peaks.length;
      const h = Math.max(2, peaks[i] * (H - 4));
      ctx.fillStyle = frac <= played ? playedGrad : colors.dim;
      roundBar(ctx, x, mid - h / 2, BAR, h);
    }

    if (hoverX >= 0) {            // hover scrubber line
      ctx.fillStyle = colors.hover;
      ctx.fillRect(hoverX, 0, 1, H);
    }
    if (played > 0 && played < 1) {  // playhead
      const px = played * W;
      ctx.fillStyle = colors.head;
      ctx.fillRect(px - 0.5, 0, 1.5, H);
    }
  }

  function tick() {
    el.cur.textContent = fmt(el.audio.currentTime);
    draw();
    if (!el.audio.paused && !el.audio.ended) raf = requestAnimationFrame(tick);
  }

  // --- decode ---
  (async () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      buffer = await audioCtx.decodeAudioData(bytes.buffer);
      relayout();
    } catch (e) {
      el.waveWrap.classList.add('ap-wave-err');
      el.waveWrap.textContent = 'Waveform unavailable: ' + e.message;
    }
  })();

  // --- transport wiring ---
  const seek = (clientX) => {
    const rect = el.canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (el.audio.duration) el.audio.currentTime = frac * el.audio.duration;
    draw();
  };

  el.play.onclick = () => { el.audio.paused ? el.audio.play() : el.audio.pause(); };
  el.audio.onplay = () => { el.root.classList.add('playing'); tick(); };
  el.audio.onpause = () => { el.root.classList.remove('playing'); };
  el.audio.onended = () => { el.root.classList.remove('playing'); draw(); };
  el.audio.onloadedmetadata = () => { el.dur.textContent = fmt(el.audio.duration); };

  let dragging = false;
  el.canvas.onpointerdown = (e) => { dragging = true; el.canvas.setPointerCapture(e.pointerId); seek(e.clientX); };
  el.canvas.onpointermove = (e) => {
    const rect = el.canvas.getBoundingClientRect();
    hoverX = e.clientX - rect.left;
    const frac = Math.min(1, Math.max(0, hoverX / rect.width));
    el.tip.textContent = fmt(frac * (el.audio.duration || 0));
    el.tip.style.left = hoverX + 'px';
    el.tip.classList.add('on');
    if (dragging) seek(e.clientX); else draw();
  };
  el.canvas.onpointerup = () => { dragging = false; };
  el.canvas.onpointerleave = () => { hoverX = -1; el.tip.classList.remove('on'); draw(); };

  let speedIdx = 0;
  el.speed.onclick = () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    el.audio.playbackRate = SPEEDS[speedIdx];
    el.speed.textContent = SPEEDS[speedIdx] + '×';
  };

  el.vol.oninput = () => { el.audio.volume = +el.vol.value; el.audio.muted = false; updateVolIcon(); };
  el.mute.onclick = () => { el.audio.muted = !el.audio.muted; updateVolIcon(); };
  const updateVolIcon = () => {
    const v = el.audio.muted ? 0 : el.audio.volume;
    el.mute.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    el.mute.classList.toggle('muted', v === 0);
  };

  const ro = new ResizeObserver(() => relayout());
  ro.observe(el.waveWrap);

  registerCleanup && registerCleanup(() => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    el.audio.pause();
  });
}

// --- one-time peak reduction: max |sample| over each bar's slice ---
function computePeaks(audioBuffer, bars) {
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / Math.max(1, bars)));
  const out = new Array(bars);
  let globalMax = 0;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const start = b * step;
    for (let i = 0; i < step; i++) {
      const v = Math.abs(data[start + i] || 0);
      if (v > peak) peak = v;
    }
    out[b] = peak;
    if (peak > globalMax) globalMax = peak;
  }
  // Normalise so the loudest bar fills the height (quiet clips still read well).
  if (globalMax > 0) for (let b = 0; b < bars; b++) out[b] /= globalMax;
  return out;
}

function roundBar(ctx, x, y, w, h) {
  const r = Math.min(w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

// Resolve theme tokens once so the waveform tracks the app's accent colours.
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
  return {
    accent: v('--accent', '#0e639c'),
    accentHi: v('--accent-hi', '#1177bb'),
    dim: '#3c4043',
    head: '#e8eaed',
    hover: 'rgba(232,234,237,0.35)',
  };
}

function buildPlayer() {
  const root = document.createElement('div');
  root.className = 'audio-player';
  root.innerHTML = `
    <div class="ap-wave-wrap">
      <canvas class="waveform"></canvas>
      <span class="ap-tip"></span>
    </div>
    <div class="ap-controls">
      <button class="ap-play" title="Play / Pause" aria-label="Play">
        <svg class="ap-ico-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg class="ap-ico-pause" viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <span class="ap-time"><span class="ap-cur">0:00</span> / <span class="ap-dur">0:00</span></span>
      <span class="ap-spacer"></span>
      <button class="ap-speed" title="Playback speed">1×</button>
      <button class="ap-mute" title="Mute">🔊</button>
      <input class="ap-vol" type="range" min="0" max="1" step="0.05" value="1" title="Volume">
    </div>
    <audio class="ap-audio" hidden></audio>`;
  const $ = (s) => root.querySelector(s);
  return {
    root,
    canvas: $('.waveform'), waveWrap: $('.ap-wave-wrap'), tip: $('.ap-tip'),
    play: $('.ap-play'), cur: $('.ap-cur'), dur: $('.ap-dur'),
    speed: $('.ap-speed'), mute: $('.ap-mute'), vol: $('.ap-vol'),
    audio: $('.ap-audio'),
    ctx: null, cssW: 0, cssH: 0,
  };
}
