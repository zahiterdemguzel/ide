// Generates assets/icon-dev.png — the icon dev runs (`npm start`) use so an
// unpackaged window is obvious in the taskbar next to an installed build.
// assets/icon.png is a palette PNG (color type 3), so the whole recolor is a
// rewrite of the 256-entry PLTE chunk; the pixel data (IDAT) is copied as-is.
const fs = require('fs');
const path = require('path');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 180° hue rotation: red↔cyan, green↔magenta. Keeps the artwork's shapes and
// luminance while making the dev icon unmistakable at taskbar size.
const rotateHue = (r, g, b) => {
  const l = 0.213 * r + 0.715 * g + 0.072 * b;
  return [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(2 * l - c))));
};

function devIcon(png) {
  const out = Buffer.from(png);
  let offset = 8; // skip the PNG signature
  while (offset < out.length) {
    const length = out.readUInt32BE(offset);
    const type = out.toString('ascii', offset + 4, offset + 8);
    if (type === 'PLTE') {
      const start = offset + 8;
      for (let i = start; i < start + length; i += 3) {
        const [r, g, b] = rotateHue(out[i], out[i + 1], out[i + 2]);
        out[i] = r; out[i + 1] = g; out[i + 2] = b;
      }
      out.writeUInt32BE(crc32(out.subarray(offset + 4, start + length)), start + length);
      return out;
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  throw new Error('assets/icon.png has no PLTE chunk — it is not a palette PNG');
}

const assets = path.join(__dirname, '..', 'assets');
fs.writeFileSync(
  path.join(assets, 'icon-dev.png'),
  devIcon(fs.readFileSync(path.join(assets, 'icon.png'))),
);
console.log('wrote assets/icon-dev.png');
