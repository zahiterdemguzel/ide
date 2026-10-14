import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleBreakpointAt, upsertBreakpoint, enabledBreakpoints, describeEdit, shiftBreakpoints,
} from '../src/renderer/shared/breakpoints-model.js';

const lines = (list) => list.map((bp) => bp.line);

test('toggleBreakpointAt adds sorted, and removes on a second click', () => {
  let list = toggleBreakpointAt([], 9);
  list = toggleBreakpointAt(list, 2);
  assert.deepEqual(list, [{ line: 2, enabled: true }, { line: 9, enabled: true }]);
  assert.deepEqual(lines(toggleBreakpointAt(list, 9)), [2]);
});

test('upsertBreakpoint replaces the breakpoint on that line', () => {
  const list = upsertBreakpoint([{ line: 4, enabled: true }], { line: 4, condition: 'x' });
  assert.deepEqual(list, [{ line: 4, enabled: true, condition: 'x' }]);
});

test('enabledBreakpoints drops disabled ones', () => {
  assert.deepEqual(lines(enabledBreakpoints([{ line: 1 }, { line: 2, enabled: false }, { line: 3, enabled: true }])), [1, 3]);
});

test('describeEdit locates the change and the line delta', () => {
  assert.deepEqual(describeEdit('a\nb\nc', 'a\nb\nX\nc'), { line: 3, atLineStart: true, delta: 1 });
  assert.deepEqual(describeEdit('a\nb\nc', 'a\nbb\nc'), { line: 2, atLineStart: false, delta: 0 });
  assert.deepEqual(describeEdit('a\nb\nc\nd', 'a\nd'), { line: 2, atLineStart: true, delta: -2 });
});

test('shiftBreakpoints: lines inserted above move breakpoints down', () => {
  const list = [{ line: 2 }, { line: 5 }];
  // Enter at the end of line 3 → everything below line 3 moves.
  assert.deepEqual(lines(shiftBreakpoints(list, describeEdit('1\n2\n3\n4\n5', '1\n2\n3\n\n4\n5'))), [2, 6]);
  // Enter at the very start of line 2 pushes line 2's breakpoint along with its code.
  assert.deepEqual(lines(shiftBreakpoints(list, describeEdit('1\n2\n3\n4\n5', '1\n\n2\n3\n4\n5'))), [3, 6]);
});

test('shiftBreakpoints: deleted lines take their breakpoints with them', () => {
  const list = [{ line: 2 }, { line: 3 }, { line: 5 }];
  // Delete lines 3–4 (join from the end of line 2).
  const edit = describeEdit('1\n2\n3\n4\n5', '1\n2\n5');
  assert.deepEqual(lines(shiftBreakpoints(list, edit)), [2, 3]);
});

test('shiftBreakpoints: an edit within a line changes nothing', () => {
  const list = [{ line: 2 }];
  assert.equal(shiftBreakpoints(list, describeEdit('a\nb', 'a\nbc')), list);
});
