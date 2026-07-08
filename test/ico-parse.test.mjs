import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIco, buildSingleIco, extractFrame, describeEntry } from '../src/renderer/shared/ico-parse.js';

// Hand-build ICO containers so the tests need no fixture files.

function u16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function u32le(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Minimal PNG prefix: signature + IHDR chunk header + big-endian width/height.
function pngPayload(width, height, extra = 4) {
  return Uint8Array.from([
    ...PNG_SIG,
    ...u32le(13).reverse(), 0x49, 0x48, 0x44, 0x52, // IHDR length + type
    (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
    (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
    ...new Array(extra).fill(0),
  ]);
}

// images: [{ w, h, bitCount, payload }] — builds header + directory + data.
function buildIco(images, type = 1) {
  const headerSize = 6 + images.length * 16;
  const dir = [0, 0, ...u16le(type), ...u16le(images.length)];
  let offset = headerSize;
  const data = [];
  for (const img of images) {
    dir.push(
      img.w >= 256 ? 0 : img.w, img.h >= 256 ? 0 : img.h, 0, 0,
      ...u16le(1), ...u16le(img.bitCount),
      ...u32le(img.payload.length), ...u32le(offset),
    );
    data.push(...img.payload);
    offset += img.payload.length;
  }
  return Uint8Array.from([...dir, ...data]);
}

test('parseIco: reads every directory entry with size, depth, and encoding', () => {
  const bmp16 = Uint8Array.from(new Array(40).fill(7)); // fake DIB payload
  const ico = buildIco([
    { w: 16, h: 16, bitCount: 32, payload: bmp16 },
    { w: 48, h: 48, bitCount: 8, payload: Uint8Array.from(new Array(20).fill(3)) },
  ]);
  const { type, entries } = parseIco(ico);
  assert.equal(type, 'icon');
  assert.equal(entries.length, 2);
  // sorted largest-first
  assert.deepEqual(entries.map((e) => e.width), [48, 16]);
  assert.deepEqual(entries.map((e) => e.bitCount), [8, 32]);
  assert.ok(entries.every((e) => !e.isPng));
});

test('parseIco: PNG frames report the IHDR size, not the 0-byte directory size', () => {
  const ico = buildIco([{ w: 256, h: 256, bitCount: 32, payload: pngPayload(256, 256) }]);
  const [e] = parseIco(ico).entries;
  assert.ok(e.isPng);
  assert.equal(e.width, 256);
  assert.equal(e.height, 256);
});

test('parseIco: width/height byte 0 means 256 for BMP frames', () => {
  const ico = buildIco([{ w: 256, h: 256, bitCount: 32, payload: Uint8Array.from(new Array(12).fill(1)) }]);
  const [e] = parseIco(ico).entries;
  assert.equal(e.width, 256);
  assert.equal(e.height, 256);
});

test('parseIco: recognizes cursor containers (.cur type 2)', () => {
  const ico = buildIco([{ w: 32, h: 32, bitCount: 1, payload: Uint8Array.from([1, 2, 3, 4]) }], 2);
  assert.equal(parseIco(ico).type, 'cursor');
});

test('parseIco: rejects non-ICO bytes and truncated containers', () => {
  assert.throws(() => parseIco(pngPayload(10, 10)), /Not an ICO/); // a renamed PNG
  assert.throws(() => parseIco(Uint8Array.from([0, 0])), /too short/);
  assert.throws(() => parseIco(Uint8Array.from([0, 0, 1, 0, 0, 0])), /no images/);
  const truncated = buildIco([{ w: 16, h: 16, bitCount: 32, payload: Uint8Array.from([1, 2, 3]) }]).subarray(0, 24);
  assert.throws(() => parseIco(truncated), /Truncated/);
});

test('buildSingleIco: repackages one frame as a standalone parseable icon', () => {
  const payload = pngPayload(64, 64);
  const ico = buildIco([
    { w: 16, h: 16, bitCount: 32, payload: Uint8Array.from(new Array(30).fill(9)) },
    { w: 64, h: 64, bitCount: 32, payload },
  ]);
  const entries = parseIco(ico).entries;
  const big = entries.find((e) => e.width === 64);
  const single = buildSingleIco(ico, big);
  const re = parseIco(single);
  assert.equal(re.entries.length, 1);
  assert.equal(re.entries[0].width, 64);
  assert.ok(re.entries[0].isPng);
  // frame bytes are copied verbatim
  assert.deepEqual([...single.subarray(22)], [...payload]);
});

test('buildSingleIco: writes 256+ sizes as the format\'s 0 byte', () => {
  const ico = buildIco([{ w: 256, h: 256, bitCount: 32, payload: pngPayload(256, 256) }]);
  const single = buildSingleIco(ico, parseIco(ico).entries[0]);
  assert.equal(single[6], 0);
  assert.equal(single[7], 0);
  assert.equal(parseIco(single).entries[0].width, 256);
});

test('extractFrame: PNG frames come out as a bare PNG stream (no ico wrapper)', () => {
  // Chromium's ICO decoder rejects PNG frames past the format's 256px cap,
  // so oversized frames (real-world icons embed e.g. 2048px PNGs) must be
  // served as plain PNG.
  const payload = pngPayload(2048, 2048);
  const ico = buildIco([{ w: 256, h: 256, bitCount: 32, payload }]);
  const [entry] = parseIco(ico).entries;
  assert.equal(entry.width, 2048); // IHDR wins over the 0-byte directory size
  const frame = extractFrame(ico, entry);
  assert.equal(frame.mime, 'image/png');
  assert.deepEqual([...frame.bytes], [...payload]);
});

test('extractFrame: BMP frames are wrapped as a single-image ico', () => {
  const ico = buildIco([{ w: 16, h: 16, bitCount: 32, payload: Uint8Array.from(new Array(30).fill(9)) }]);
  const [entry] = parseIco(ico).entries;
  const frame = extractFrame(ico, entry);
  assert.equal(frame.mime, 'image/x-icon');
  assert.equal(parseIco(frame.bytes).entries[0].width, 16);
});

test('describeEntry: human label with size, depth, and encoding', () => {
  assert.equal(describeEntry({ width: 32, height: 32, bitCount: 32, isPng: false }), '32×32 · 32-bit · BMP');
  assert.equal(describeEntry({ width: 256, height: 256, bitCount: 0, isPng: true }), '256×256 · PNG');
});
