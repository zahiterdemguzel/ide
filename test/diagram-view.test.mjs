import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitTransform, zoomAt, toDiagram, centerOn, transformAttr, edgePath, endAngle,
  memberLabel, fitLabel, matchNodes, matchEdges, crumbs, drillTarget,
  MIN_SCALE, MAX_SCALE,
} from '../src/renderer/shared/diagram-view.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// --- viewport --------------------------------------------------------------

test('fitTransform scales a large diagram down and centres it', () => {
  const t = fitTransform({ width: 1000, height: 500 }, 500, 500, 0);
  near(t.scale, 0.5);
  near(t.x, 0);
  near(t.y, 125);
});

test('fitTransform never magnifies past 1:1', () => {
  const t = fitTransform({ width: 100, height: 50 }, 1000, 1000, 0);
  assert.equal(t.scale, 1);
});

test('fitTransform survives an empty diagram', () => {
  assert.deepEqual(fitTransform({ width: 0, height: 0 }, 800, 600), { scale: 1, x: 0, y: 0 });
});

test('zoomAt keeps the point under the cursor fixed', () => {
  const t = { scale: 1, x: 0, y: 0 };
  const before = toDiagram(t, 300, 200);
  const zoomed = zoomAt(t, 2, 300, 200);
  const after = toDiagram(zoomed, 300, 200);
  near(after.x, before.x);
  near(after.y, before.y);
  near(zoomed.scale, 2);
});

test('zoomAt clamps to the scale limits', () => {
  assert.equal(zoomAt({ scale: MAX_SCALE, x: 0, y: 0 }, 10, 0, 0).scale, MAX_SCALE);
  assert.equal(zoomAt({ scale: MIN_SCALE, x: 0, y: 0 }, 0.01, 0, 0).scale, MIN_SCALE);
});

test('centerOn puts a node rect in the middle of the viewport', () => {
  const t = centerOn({ scale: 2 }, { x: 100, y: 50, width: 40, height: 20 }, 800, 600);
  // the rect centre is (120, 60) in diagram space; at scale 2 that is (240,120)
  near(t.x, 400 - 240);
  near(t.y, 300 - 120);
  assert.equal(t.scale, 2);
});

test('transformAttr emits translate-then-scale, the order the SVG expects', () => {
  assert.equal(transformAttr({ x: 10, y: 20, scale: 1.5 }), 'translate(10 20) scale(1.5)');
});

// --- edges -----------------------------------------------------------------

test('edgePath draws a straight line for two points', () => {
  assert.equal(edgePath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 'M 0 0 L 10 0');
});

test('edgePath rounds each bend with a quadratic', () => {
  const d = edgePath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 6);
  assert.match(d, /^M 0 0 /);
  assert.match(d, /Q 50 0/, 'the corner point becomes the control point');
  assert.match(d, /L 50 50$/);
});

test('edgePath never rounds more than half a segment', () => {
  // Segments of length 4 with radius 6 would otherwise overshoot the corner.
  const d = edgePath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], 6);
  assert.match(d, /L 2 0 Q 4 0 4 2/);
});

test('edgePath is empty for a degenerate route', () => {
  assert.equal(edgePath([]), '');
  assert.equal(edgePath([{ x: 1, y: 1 }]), '');
  assert.equal(edgePath(undefined), '');
});

test('endAngle follows the last segment', () => {
  assert.equal(endAngle([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 0);
  assert.equal(endAngle([{ x: 0, y: 0 }, { x: 0, y: 10 }]), 90);
  assert.equal(endAngle([{ x: 10, y: 0 }, { x: 0, y: 0 }]), 180);
  assert.equal(endAngle([{ x: 0, y: 0 }]), 0);
});

// --- labels ----------------------------------------------------------------

test('memberLabel marks visibility the UML way', () => {
  assert.equal(memberLabel({ name: 'x', visibility: 'private' }), '− x');
  assert.equal(memberLabel({ name: 'x', visibility: 'protected' }), '# x');
  assert.equal(memberLabel({ name: 'x', visibility: 'public' }), '+ x');
  assert.equal(memberLabel({ name: 'run', signature: '(a, b)' }), '+ run(a, b)');
});

test('fitLabel truncates from the end, or from the start for paths', () => {
  assert.equal(fitLabel('short', 200), 'short');
  assert.equal(fitLabel('abcdefghij', 6.6 * 5), 'abcd…');
  assert.equal(fitLabel('abcdefghij', 6.6 * 5, 6.6, true), '…ghij');
  assert.equal(fitLabel('', 100), '');
  assert.equal(fitLabel(undefined, 100), '');
});

// --- search ----------------------------------------------------------------

const NODES = [
  { id: 'a', name: 'Widget', file: 'src/ui.js', members: [{ name: 'render' }] },
  { id: 'b', name: 'Store', file: 'src/state.js', members: [] },
  { id: 'c', name: 'Helper', file: 'lib/h.js', members: [] },
];

test('matchNodes distinguishes "no search" from "no hits"', () => {
  assert.equal(matchNodes(NODES, ''), null);
  assert.equal(matchNodes(NODES, '   '), null);
  assert.equal(matchNodes(NODES, 'zzz').size, 0);
});

test('matchNodes searches name, path and members, case-insensitively', () => {
  assert.deepEqual([...matchNodes(NODES, 'widg')], ['a']);
  assert.deepEqual([...matchNodes(NODES, 'RENDER')], ['a']);
  assert.deepEqual([...matchNodes(NODES, 'src/')], ['a', 'b']);
});

test('matchEdges highlights only edges with both ends highlighted', () => {
  const hits = new Set(['a', 'b']);
  const on = matchEdges([
    { kind: 'imports', from: 'a', to: 'b' },
    { kind: 'imports', from: 'a', to: 'c' },
  ], hits);
  assert.deepEqual([...on], ['imports a b']);
  assert.equal(matchEdges([], null), null);
});

// --- drill-in --------------------------------------------------------------

test('crumbs builds a root-first trail', () => {
  assert.deepEqual(crumbs(''), [{ label: 'Project', focus: '' }]);
  assert.deepEqual(crumbs('src/app/ui'), [
    { label: 'Project', focus: '' },
    { label: 'src', focus: 'src' },
    { label: 'app', focus: 'src/app' },
    { label: 'ui', focus: 'src/app/ui' },
  ]);
});

test('drillTarget descends into folders, and into a file\'s folder', () => {
  assert.equal(drillTarget({ kind: 'folder', file: 'src/app' }), 'src/app');
  assert.equal(drillTarget({ kind: 'module', file: 'src/app/main.js' }), 'src/app');
  assert.equal(drillTarget({ kind: 'module', file: 'main.js' }), '');
  assert.equal(drillTarget({ kind: 'class', file: 'a.js' }), null);
  assert.equal(drillTarget(null), null);
});
