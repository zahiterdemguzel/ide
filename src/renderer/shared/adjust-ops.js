// Pure pixel math for the image adjustment view — no DOM, so it's unit-testable.
// Operates on RGBA buffers (the shape of a canvas ImageData's `data`): a flat
// Uint8ClampedArray of [r,g,b,a, r,g,b,a, …].

// Each control is a slider in [-100, 100]; 0 is the identity ("neutral") value.
export const ADJUSTMENTS = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'vibrance', label: 'Vibrance' },
  { key: 'temperature', label: 'Temperature' },
  { key: 'tint', label: 'Tint' },
];

export const DEFAULTS = Object.freeze(Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])));

export const isNeutral = (v) => ADJUSTMENTS.every((a) => (v[a.key] || 0) === 0);

const clamp8 = (n) => (n < 0 ? 0 : n > 255 ? 255 : n);

// Exposure, brightness, contrast, temperature and tint are all per-channel point
// operations, so they collapse into one 256-entry lookup table per channel — the
// per-pixel loop then costs three array reads instead of a chain of arithmetic.
// Saturation and vibrance mix the three channels together, so they can't be a LUT
// and are applied per pixel afterwards.
export function buildChannelLuts(v) {
  const exp = Math.pow(2, (v.exposure || 0) / 100); // ±1 photographic stop at the extremes
  const bright = (v.brightness || 0) * 1.28; // additive, ±128 of the 0..255 range
  const c = (v.contrast || 0) * 2.55; // map the slider onto the classic −255..255 contrast
  const contrastF = (259 * (c + 255)) / (255 * (259 - c));
  const tempOff = (v.temperature || 0) * 0.3; // warm (+) lifts red, drops blue
  const tintOff = -(v.tint || 0) * 0.3; // +tint = magenta, i.e. less green

  // offset is the channel's white-balance shift (red/green/blue differ).
  const lut = (offset) => {
    const t = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let n = i * exp + offset + bright;
      n = (n - 128) * contrastF + 128; // contrast pivots around mid-grey
      t[i] = clamp8(n);
    }
    return t;
  };
  return { r: lut(tempOff), g: lut(tintOff), b: lut(-tempOff) };
}

// Rec. 601 luma — the grey a pixel desaturates toward.
const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114;

// Apply the full pipeline from `src` into `dst` (both RGBA buffers of equal length).
// Alpha is copied through untouched.
export function applyAdjustments(src, dst, v) {
  const { r: lr, g: lg, b: lb } = buildChannelLuts(v);
  const sat = 1 + (v.saturation || 0) / 100; // 0 (grey) .. 2 (double)
  const vib = (v.vibrance || 0) / 100; // −1 .. 1
  const mixes = sat !== 1 || vib !== 0; // skip the colour-mix maths when neither moves
  for (let i = 0; i < src.length; i += 4) {
    let r = lr[src[i]], g = lg[src[i + 1]], b = lb[src[i + 2]];
    if (mixes) {
      const gray = LUMA_R * r + LUMA_G * g + LUMA_B * b;
      const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      // Vibrance leans on the pixel's existing saturation: near-grey pixels get the
      // most boost and already-vivid ones the least, so skin tones don't blow out.
      const m = sat * (1 + vib * (1 - (max - min) / 255));
      r = gray + (r - gray) * m;
      g = gray + (g - gray) * m;
      b = gray + (b - gray) * m;
    }
    dst[i] = clamp8(r);
    dst[i + 1] = clamp8(g);
    dst[i + 2] = clamp8(b);
    dst[i + 3] = src[i + 3];
  }
}
