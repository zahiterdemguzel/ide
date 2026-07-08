// Pure ICO container parsing (no DOM / Electron) so it stays unit-testable.
// An .ico is a directory of independently-encoded frames (different sizes /
// bit depths); the asset viewer shows every frame, not just the one Chromium
// would pick for an <img>. Each frame is either a PNG stream (modern, usually
// the 256px entry) or a BMP DIB. We never decode pixels here — to display a
// single frame the viewer wraps its untouched bytes in a one-entry .ico
// (buildSingleIco) and lets Chromium's own decoder handle both encodings.

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u16(b, off) { return b[off] | (b[off + 1] << 8); }
function u32(b, off) { return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0; }

function isPngAt(bytes, off) {
  return PNG_SIG.every((v, i) => bytes[off + i] === v);
}

// PNG frames self-describe their size in the IHDR chunk (big-endian, right
// after the 8-byte signature + 8-byte chunk header); trust that over the
// directory's u8 fields, which cap at 255 and are often left 0.
function pngDims(bytes, off) {
  const w = (bytes[off + 16] << 24) | (bytes[off + 17] << 16) | (bytes[off + 18] << 8) | bytes[off + 19];
  const h = (bytes[off + 20] << 24) | (bytes[off + 21] << 16) | (bytes[off + 22] << 8) | bytes[off + 23];
  return { width: w >>> 0, height: h >>> 0 };
}

// Parse the ICONDIR + entries of an .ico (or .cur) file. Returns
// { type: 'icon' | 'cursor', entries: [{ width, height, bitCount, size,
// offset, isPng }] } sorted largest-first; throws on anything that isn't an
// ICO container so the caller can fall back to a plain <img>.
export function parseIco(bytes) {
  if (bytes.length < HEADER_SIZE) throw new Error('Not an ICO file (too short)');
  const reserved = u16(bytes, 0);
  const type = u16(bytes, 2);
  const count = u16(bytes, 4);
  if (reserved !== 0 || (type !== 1 && type !== 2)) throw new Error('Not an ICO file (bad header)');
  if (count === 0) throw new Error('ICO file contains no images');
  if (bytes.length < HEADER_SIZE + count * ENTRY_SIZE) throw new Error('Truncated ICO directory');

  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = HEADER_SIZE + i * ENTRY_SIZE;
    // width/height are single bytes where 0 means 256
    let width = bytes[e] || 256;
    let height = bytes[e + 1] || 256;
    const bitCount = u16(bytes, e + 6); // hotspot Y for cursors — reported as-is
    const size = u32(bytes, e + 8);
    const offset = u32(bytes, e + 12);
    if (offset + size > bytes.length || size === 0) throw new Error('Truncated ICO image data');
    const isPng = isPngAt(bytes, offset);
    if (isPng && size >= 24) ({ width, height } = pngDims(bytes, offset));
    entries.push({ width, height, bitCount, size, offset, isPng });
  }
  entries.sort((a, b) => b.width * b.height - a.width * a.height || b.bitCount - a.bitCount);
  return { type: type === 2 ? 'cursor' : 'icon', entries };
}

// Repackage one parsed entry as a standalone single-image .ico, so an <img>
// with MIME image/x-icon decodes exactly that frame (Chromium otherwise picks
// one frame of a multi-image ico itself). Frame bytes are copied verbatim.
export function buildSingleIco(bytes, entry) {
  const out = new Uint8Array(HEADER_SIZE + ENTRY_SIZE + entry.size);
  // ICONDIR: reserved 0, type 1 (icon), count 1
  out[2] = 1; out[4] = 1;
  // ICONDIRENTRY: sizes of 256+ are written as 0 per the format
  out[6] = entry.width >= 256 ? 0 : entry.width;
  out[7] = entry.height >= 256 ? 0 : entry.height;
  out[12] = entry.bitCount & 0xff; out[13] = (entry.bitCount >> 8) & 0xff;
  const size = entry.size;
  out[14] = size & 0xff; out[15] = (size >> 8) & 0xff; out[16] = (size >> 16) & 0xff; out[17] = (size >> 24) & 0xff;
  const offset = HEADER_SIZE + ENTRY_SIZE;
  out[18] = offset;
  out.set(bytes.subarray(entry.offset, entry.offset + entry.size), offset);
  return out;
}

// Bytes + MIME to display one frame with. A PNG frame is a complete PNG
// stream, served as-is — Chromium's PNG decoder has no size limit, whereas
// its ICO decoder chokes on PNG frames beyond the format's 256px cap (real
// files exceed it: dir sizes are one byte, so oversized frames just write 0).
// BMP frames are headerless DIBs, so those do get the single-ico wrapper.
export function extractFrame(bytes, entry) {
  if (entry.isPng) return { bytes: bytes.subarray(entry.offset, entry.offset + entry.size), mime: 'image/png' };
  return { bytes: buildSingleIco(bytes, entry), mime: 'image/x-icon' };
}

// Human label for a frame card, e.g. "32×32 · 32-bit · PNG".
export function describeEntry(entry) {
  const depth = entry.bitCount ? `${entry.bitCount}-bit` : null;
  return [`${entry.width}×${entry.height}`, depth, entry.isPng ? 'PNG' : 'BMP'].filter(Boolean).join(' · ');
}
