// Palette + colour math for the pixel editor.
export const PALETTE = ['#000000', '#ffffff', '#f85149', '#3fb950', '#0e639c', '#e2c08d', '#a371f7', '#6e7681'];

export const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// amt>0 lightens toward white, <0 darkens toward black — works at the #000/#fff extremes a plain multiply can't escape.
export const shade = (hex, amt) => { const [r, g, b] = hexToRgb(hex), t = amt > 0 ? 255 : 0, f = Math.abs(amt); return rgbToHex(r + (t - r) * f, g + (t - g) * f, b + (t - b) * f); };
