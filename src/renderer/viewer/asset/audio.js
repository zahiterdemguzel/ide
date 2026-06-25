// Audio view: an <audio> player plus a peak-per-column waveform drawn from
// AudioContext.decodeAudioData (base64 → ArrayBuffer, no network). `body` is the
// asset view's body container.
let audioCtx;

export function renderAudio(dataUrl, base64, body) {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = dataUrl;
  audio.className = 'asset-audio';
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform';
  body.append(audio, canvas);
  canvas.width = body.clientWidth - 24;
  canvas.height = 160;

  (async () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buf = await audioCtx.decodeAudioData(bytes.buffer);
      drawWaveform(canvas, buf);
    } catch (e) {
      const c = canvas.getContext('2d');
      c.fillStyle = '#858585';
      c.fillText('Waveform unavailable: ' + e.message, 8, 20);
    }
  })();
}

// Peak-per-column waveform: scan each pixel's slice of samples for min/max.
function drawWaveform(canvas, audioBuffer) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, mid = H / 2;
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e639c';
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) {
      const v = data[x * step + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.fillRect(x, (1 + min) * mid, 1, Math.max(1, (max - min) * mid));
  }
}
