// Derives the icon variants both apps run on from the one committed source,
// assets/icon.png: a hue-rotated `-dev` twin so an unpackaged run is obvious
// next to an installed build, and copies of both under mobile/assets/ so the
// phone app wears the same mark. Everything it writes is gitignored.
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
const mobileAssets = path.join(__dirname, '..', 'mobile', 'assets');
const prod = fs.readFileSync(path.join(assets, 'icon.png'));
const dev = devIcon(prod);

fs.mkdirSync(mobileAssets, { recursive: true });
const written = [
  [path.join(assets, 'icon-dev.png'), dev],
  [path.join(mobileAssets, 'icon.png'), prod],
  [path.join(mobileAssets, 'icon-dev.png'), dev],
];
for (const [file, data] of written) fs.writeFileSync(file, data);
console.log(`wrote ${written.length} icon variants`);
