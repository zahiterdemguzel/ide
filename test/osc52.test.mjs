import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOsc52 } from '../src/renderer/shared/osc52.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('decodeOsc52: decodes a c;<base64> payload', () => {
  assert.equal(decodeOsc52(`c;${b64('hello world')}`), 'hello world');
});

test('decodeOsc52: accepts other selection targets (p, q, …) and empty Pc', () => {
  assert.equal(decodeOsc52(`p;${b64('primary')}`), 'primary');
  assert.equal(decodeOsc52(`;${b64('no target')}`), 'no target');
});

test('decodeOsc52: decodes multi-byte UTF-8 (not latin1)', () => {
  assert.equal(decodeOsc52(`c;${b64('café — 日本語')}`), 'café — 日本語');
});

test('decodeOsc52: a read request ("?") yields null', () => {
  assert.equal(decodeOsc52('c;?'), null);
});

test('decodeOsc52: empty, malformed, and non-string payloads yield null', () => {
  assert.equal(decodeOsc52('c;'), null);
  assert.equal(decodeOsc52(''), null);
  assert.equal(decodeOsc52('c;not valid base64!!!'), null);
  assert.equal(decodeOsc52(null), null);
  assert.equal(decodeOsc52(undefined), null);
});

test('decodeOsc52: tolerates surrounding whitespace in the base64', () => {
  assert.equal(decodeOsc52(`c;  ${b64('trimmed')}  `), 'trimmed');
});
