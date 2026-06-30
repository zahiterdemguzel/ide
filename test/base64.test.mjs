import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64ToArrayBuffer, arrayBufferToBase64, base64ToText, textToBase64 } from '../src/renderer/shared/base64.js';

// node provides atob/btoa globally (used by the helpers); assert that here so a
// failure points at the environment, not the round-trip logic.
test('atob/btoa are available in the test runtime', () => {
  assert.equal(typeof atob, 'function');
  assert.equal(typeof btoa, 'function');
});

test('arrayBufferToBase64 ↔ base64ToArrayBuffer round-trips small bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
  const b64 = arrayBufferToBase64(bytes.buffer);
  const back = new Uint8Array(base64ToArrayBuffer(b64));
  assert.deepEqual([...back], [...bytes]);
});

test('arrayBufferToBase64 accepts a Uint8Array directly', () => {
  const bytes = new Uint8Array([10, 20, 30]);
  assert.equal(arrayBufferToBase64(bytes), arrayBufferToBase64(bytes.buffer));
});

test('round-trips a multi-chunk buffer without a stack overflow', () => {
  // > the 0x8000 chunk size, with every byte value cycling through 0..255, so a
  // naive String.fromCharCode.apply over the whole array would overflow here.
  const n = 0x8000 * 3 + 17;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i % 256;
  const back = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
  assert.equal(back.length, n);
  for (let i = 0; i < n; i++) assert.equal(back[i], i % 256);
});

test('empty buffer round-trips to an empty buffer', () => {
  assert.equal(arrayBufferToBase64(new Uint8Array(0)), '');
  assert.equal(base64ToArrayBuffer('').byteLength, 0);
});

// textToBase64/base64ToText back the SVG save/load round-trip. The point of
// going via UTF-8 bytes (not btoa) is that non-Latin1 text survives.
test('textToBase64 ↔ base64ToText round-trips ASCII, multibyte, and empty', () => {
  for (const s of ['', 'hello', 'şçöü ğıİ', 'palette 🎨 vector', '<svg><text>café</text></svg>']) {
    assert.equal(base64ToText(textToBase64(s)), s);
  }
});

test('textToBase64 encodes UTF-8 bytes (not a btoa of the raw string)', () => {
  // "é" is U+00E9 -> UTF-8 0xC3 0xA9; assert the bytes, so a regression to btoa
  // (which would emit a single 0xE9 or throw) is caught.
  const bytes = new Uint8Array(base64ToArrayBuffer(textToBase64('é')));
  assert.deepEqual([...bytes], [0xc3, 0xa9]);
});

test('a real SVG string with non-ASCII content round-trips byte-for-byte', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="1" y="9">Görüş 🎨</text></svg>';
  assert.equal(base64ToText(textToBase64(svg)), svg);
});
