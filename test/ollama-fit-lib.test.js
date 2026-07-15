const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelFit, formatReq } = require('../src/main/ollama-fit-lib');

const M = { minRam: 8, minVram: 6 };

test('modelFit: fits comfortably -> ok', () => {
  assert.equal(modelFit(M, { ramGB: 32, vramGB: 24 }).level, 'ok');
});

test('modelFit: over RAM or VRAM budget -> fail', () => {
  assert.deepEqual(modelFit(M, { ramGB: 4, vramGB: 24 }), { level: 'fail', reason: 'ram' });
  assert.deepEqual(modelFit(M, { ramGB: 32, vramGB: 4 }), { level: 'fail', reason: 'vram' });
});

test('modelFit: within the headroom margin -> tight', () => {
  // 6 GB VRAM needed, 6.5 available -> > 85% -> tight.
  assert.equal(modelFit(M, { ramGB: 32, vramGB: 6.5 }).level, 'tight');
});

test('modelFit: unknown VRAM falls back to RAM-only', () => {
  assert.equal(modelFit(M, { ramGB: 32, vramGB: null }).level, 'ok');
  assert.equal(modelFit(M, { ramGB: 4, vramGB: null }).level, 'fail');
});

test('modelFit: unified memory treats RAM as the VRAM pool', () => {
  // No discrete VRAM, but 32 GB unified -> the 6 GB VRAM need is met.
  assert.equal(modelFit(M, { ramGB: 32, vramGB: null, unified: true }).level, 'ok');
  assert.equal(modelFit(M, { ramGB: 4, vramGB: null, unified: true }).level, 'fail');
});

test('modelFit: no requirement or no system info -> unknown', () => {
  assert.equal(modelFit({}, { ramGB: 32, vramGB: 24 }).level, 'unknown');
  assert.equal(modelFit(M, { ramGB: null, vramGB: null }).level, 'unknown');
});

test('formatReq: renders the RAM/VRAM line', () => {
  assert.equal(formatReq(M), 'RAM 8 GB · VRAM 6 GB');
  assert.equal(formatReq({ minRam: 16 }), 'RAM 16 GB');
  assert.equal(formatReq({}), '');
});
