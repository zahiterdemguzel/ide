import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSvgSize, applySvgSize, ensureSvgXmlns,
  aiKind, aiInfo,
  moveItem, bringToFront, sendToBack, forwardOne, backwardOne,
  alignOffsets, snapPoint, zoomToward,
} from '../src/renderer/shared/svg-ops.js';

// --- SVG root tag parsing -------------------------------------------------

test('parseSvgSize: reads width/height/viewBox from the root tag', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48"><rect/></svg>';
  assert.deepEqual(parseSvgSize(svg), { width: '64', height: '48', viewBox: '0 0 64 48' });
});

test('parseSvgSize: tolerates single quotes, unit suffixes, missing attrs', () => {
  assert.deepEqual(parseSvgSize("<svg width='10mm' height='20mm'></svg>"), { width: '10mm', height: '20mm', viewBox: null });
  assert.deepEqual(parseSvgSize('<svg viewBox="0 0 1 1"></svg>'), { width: null, height: null, viewBox: '0 0 1 1' });
});

test('parseSvgSize: no root <svg> -> all null', () => {
  assert.deepEqual(parseSvgSize('<not-svg/>'), { width: null, height: null, viewBox: null });
});

test('applySvgSize: replaces existing and inserts missing attrs, only for keys given', () => {
  const out = applySvgSize('<svg width="1" viewBox="0 0 1 1"><g/></svg>', { width: '64', height: '48' });
  assert.equal(parseSvgSize(out).width, '64');
  assert.equal(parseSvgSize(out).height, '48'); // inserted
  assert.equal(parseSvgSize(out).viewBox, '0 0 1 1'); // untouched (not in size)
  assert.ok(out.includes('<g/>')); // body preserved
});

test('applySvgSize: null/undefined fields are skipped, body untouched', () => {
  const svg = '<svg width="5" height="5"></svg>';
  const out = applySvgSize(svg, { width: null, height: undefined, viewBox: '0 0 5 5' });
  assert.equal(parseSvgSize(out).width, '5');
  assert.equal(parseSvgSize(out).viewBox, '0 0 5 5');
});

test('applySvgSize: works on a self-closing root tag', () => {
  const out = applySvgSize('<svg width="1"/>', { height: '2' });
  assert.equal(parseSvgSize(out).height, '2');
  assert.ok(/\/>\s*$/.test(out));
});

test('ensureSvgXmlns: adds xmlns when missing, leaves an existing one alone', () => {
  assert.ok(ensureSvgXmlns('<svg width="1"></svg>').includes('xmlns="http://www.w3.org/2000/svg"'));
  const already = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  assert.equal((ensureSvgXmlns(already).match(/xmlns=/g) || []).length, 1);
});

test('ensureSvgXmlns: adds xmlns:xlink only when an xlink: reference is present', () => {
  const withLink = '<svg><use xlink:href="#a"/></svg>';
  assert.ok(ensureSvgXmlns(withLink).includes('xmlns:xlink="http://www.w3.org/1999/xlink"'));
  assert.ok(!ensureSvgXmlns('<svg><rect/></svg>').includes('xmlns:xlink'));
});

// --- .ai sniffing ---------------------------------------------------------

test('aiKind: PDF-backed, PostScript, and unknown', () => {
  assert.equal(aiKind('%PDF-1.6\n...'), 'pdf');
  assert.equal(aiKind('%!PS-Adobe-3.0 EPSF-3.0\n'), 'postscript');
  assert.equal(aiKind('﻿%PDF-1.5'), 'pdf'); // leading BOM tolerated
  assert.equal(aiKind('GIF89a'), 'unknown');
});

test('aiInfo: extracts kind, version, creator and MediaBox/BoundingBox size', () => {
  const pdf = '%PDF-1.6\n%%Creator: Adobe Illustrator 25.0\n/MediaBox [0 0 612 792]';
  assert.deepEqual(aiInfo(pdf), { kind: 'pdf', version: 'PDF 1.6', creator: 'Adobe Illustrator 25.0', width: 612, height: 792 });

  const ps = '%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%BoundingBox: 0 0 100 50';
  const info = aiInfo(ps);
  assert.equal(info.kind, 'postscript');
  assert.equal(info.creator, 'Adobe Illustrator(R) 8.0');
  assert.equal(info.width, 100);
  assert.equal(info.height, 50);
});

test('aiInfo: missing metadata yields nulls, never throws', () => {
  assert.deepEqual(aiInfo('%PDF-1.4'), { kind: 'pdf', version: 'PDF 1.4', creator: null, width: null, height: null });
});

// --- z-order (front == end of array) --------------------------------------

test('z-order moves return new arrays and leave the input unchanged', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(bringToFront(order, 1), ['a', 'c', 'd', 'b']);
  assert.deepEqual(sendToBack(order, 2), ['c', 'a', 'b', 'd']);
  assert.deepEqual(forwardOne(order, 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(backwardOne(order, 2), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveItem(order, 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']); // untouched
});

test('z-order: out-of-range and edge indices are safe no-ops / clamps', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(forwardOne(order, 2), ['a', 'b', 'c']); // already front, clamps
  assert.deepEqual(backwardOne(order, 0), ['a', 'b', 'c']); // already back, clamps
  assert.deepEqual(bringToFront(order, 9), ['a', 'b', 'c']); // out of range -> copy
});

// --- align / distribute ---------------------------------------------------

test('alignOffsets: left/right/center align to the union bounds', () => {
  const bounds = [
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 20, y: 5, width: 30, height: 10 },
  ];
  assert.deepEqual(alignOffsets(bounds, 'left').map((d) => d.dx), [0, -20]);
  assert.deepEqual(alignOffsets(bounds, 'right').map((d) => d.dx), [40, 0]); // maxX = 50
  const hc = alignOffsets(bounds, 'hcenter'); // union center x = 25
  assert.equal(hc[0].dx, 20); // 25 - 5
  assert.equal(hc[1].dx, -10); // 25 - 35
});

test('alignOffsets: distribute spaces the middle item evenly between extremes', () => {
  const bounds = [
    { x: 0, y: 0, width: 0, height: 0 },   // center 0
    { x: 30, y: 0, width: 0, height: 0 },  // center 30 (should move to 50)
    { x: 100, y: 0, width: 0, height: 0 }, // center 100
  ];
  const d = alignOffsets(bounds, 'dist-h');
  assert.equal(d[0].dx, 0);
  assert.equal(d[1].dx, 20); // 30 -> 50
  assert.equal(d[2].dx, 0);
});

test('alignOffsets: empty input returns an empty array', () => {
  assert.deepEqual(alignOffsets([], 'left'), []);
});

// --- pan / zoom / snap ----------------------------------------------------

test('snapPoint: rounds to the nearest grid step, no-op when step <= 0', () => {
  assert.deepEqual(snapPoint({ x: 13, y: 27 }, 10), { x: 10, y: 30 });
  assert.deepEqual(snapPoint({ x: 13, y: 27 }, 0), { x: 13, y: 27 });
});

test('zoomToward: keeps the cursor point fixed on screen', () => {
  // (p - center)*zoom must stay constant; verify the returned center satisfies it.
  const center = { x: 0, y: 0 }, point = { x: 100, y: 50 };
  const z0 = 1, z1 = 2;
  const c1 = zoomToward(center, z0, z1, point);
  // screen offset before vs after
  assert.ok(Math.abs((point.x - center.x) * z0 - (point.x - c1.x) * z1) < 1e-9);
  assert.ok(Math.abs((point.y - center.y) * z0 - (point.y - c1.y) * z1) < 1e-9);
});
