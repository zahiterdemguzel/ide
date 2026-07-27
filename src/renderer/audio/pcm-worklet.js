// Mic tap for voice input: forwards raw mono Float32 samples to voice.js, which
// ships them to the main process for recognition.
//
// It is a real file rather than a blob URL because the renderer's CSP is
// `script-src 'self'` — a blob-backed worklet would be blocked.
//
// The AudioContext is created at 16 kHz (what Whisper wants), so no resampling
// happens here. Frames arrive 128 samples at a time; posting each one would mean
// ~125 IPC messages a second, so they're batched to BATCH samples (~64 ms) first.
// `gate` is flipped from the main thread instead of tearing the graph down, so
// arming on hover costs nothing and never loses the first words of a phrase.

const BATCH = 1024;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH);
    this.filled = 0;
    this.gate = false;
    this.port.onmessage = (e) => {
      const open = !!(e.data && e.data.gate);
      // Drop a partial batch when closing, so the next phrase doesn't start with
      // stale audio from the last one.
      if (!open) this.filled = 0;
      this.gate = open;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !this.gate) return true;
    // Bulk copies rather than a per-sample loop: this runs on the audio render
    // thread, where jitter is audible, so prefer a memcpy over 128 compares.
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(BATCH - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === BATCH) {
        // Copy: the buffer is reused, and the receiver holds it across a tick.
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
