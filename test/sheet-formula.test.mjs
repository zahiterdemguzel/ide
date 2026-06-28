import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula, isError } from '../src/renderer/shared/sheet-formula.js';
import { parseA1 } from '../src/renderer/shared/sheet-model.js';

// A tiny in-memory grid keyed by "col,row". Values can be literals or formulas
// (a string starting with '='), recomputed recursively with cycle detection —
// the same contract the real grid gives the engine.
function makeCtx(cells) {
  const map = new Map();
  for (const [a1, v] of Object.entries(cells)) { const p = parseA1(a1); map.set(p.col + ',' + p.row, v); }
  const stack = new Set();
  const ctx = {
    getCell(col, row) {
      const key = col + ',' + row;
      const raw = map.has(key) ? map.get(key) : null;
      if (typeof raw === 'string' && raw.startsWith('=')) {
        if (stack.has(key)) return '#REF!'; // cycle
        stack.add(key);
        try { return evaluateFormula(raw, ctx); } finally { stack.delete(key); }
      }
      return raw;
    },
  };
  return ctx;
}
const evL = (f, cells = {}) => evaluateFormula(f, makeCtx(cells));

test('arithmetic with precedence and parentheses', () => {
  assert.equal(evL('=1+2*3'), 7);
  assert.equal(evL('=(1+2)*3'), 9);
  assert.equal(evL('=2^10'), 1024);
  assert.equal(evL('=-3+4'), 1);
  assert.equal(evL('=10/4'), 2.5);
  assert.equal(evL('=50%'), 0.5);
});

test('cell references and ranges', () => {
  const cells = { A1: 1, A2: 2, A3: 3, B1: 10 };
  assert.equal(evL('=A1+A2+A3', cells), 6);
  assert.equal(evL('=SUM(A1:A3)', cells), 6);
  assert.equal(evL('=SUM(A1:A3,B1)', cells), 16);
  assert.equal(evL('=$A$1*2', cells), 2);
});

test('aggregation functions skip blanks and text', () => {
  const cells = { A1: 10, A2: '', A3: 'x', A4: 20 };
  assert.equal(evL('=SUM(A1:A4)', cells), 30);
  assert.equal(evL('=COUNT(A1:A4)', cells), 2);
  assert.equal(evL('=COUNTA(A1:A4)', cells), 3);
  assert.equal(evL('=AVERAGE(A1:A4)', cells), 15);
  assert.equal(evL('=MIN(A1:A4)', cells), 10);
  assert.equal(evL('=MAX(A1:A4)', cells), 20);
});

test('IF / logical / IFERROR', () => {
  assert.equal(evL('=IF(1>2,"yes","no")'), 'no');
  assert.equal(evL('=IF(AND(1,1),"a","b")'), 'a');
  assert.equal(evL('=IF(OR(0,0),"a","b")'), 'b');
  assert.equal(evL('=IFERROR(1/0,"oops")'), 'oops');
  assert.equal(evL('=IFERROR(5,"oops")'), 5);
});

test('text functions and concatenation', () => {
  assert.equal(evL('="foo"&"bar"'), 'foobar');
  assert.equal(evL('=CONCATENATE("a","b","c")'), 'abc');
  assert.equal(evL('=UPPER("abc")'), 'ABC');
  assert.equal(evL('=LEN("hello")'), 5);
  assert.equal(evL('=LEFT("hello",2)'), 'he');
  assert.equal(evL('=MID("hello",2,3)'), 'ell');
});

test('errors: divide-by-zero, unknown name, propagation', () => {
  assert.equal(evL('=1/0'), '#DIV/0!');
  assert.equal(evL('=FOO(1)'), '#NAME?');
  assert.ok(isError(evL('=1/0')));
  // an error in a referenced cell propagates through arithmetic
  assert.equal(evL('=A1+1', { A1: '=1/0' }), '#DIV/0!');
});

test('COUNTIF / SUMIF with criteria', () => {
  const cells = { A1: 5, A2: 15, A3: 25, B1: 1, B2: 2, B3: 3 };
  assert.equal(evL('=COUNTIF(A1:A3,">10")', cells), 2);
  assert.equal(evL('=SUMIF(A1:A3,">10",B1:B3)', cells), 5); // B2+B3
  assert.equal(evL('=COUNTIF(A1:A3,5)', cells), 1);
});

test('VLOOKUP exact match', () => {
  const cells = { A1: 'apple', B1: 3, A2: 'pear', B2: 7, A3: 'plum', B3: 9 };
  assert.equal(evL('=VLOOKUP("pear",A1:B3,2,FALSE)', cells), 7);
  assert.equal(evL('=VLOOKUP("grape",A1:B3,2,FALSE)', cells), '#N/A');
});

test('comparisons return booleans', () => {
  assert.equal(evL('=2>1'), true);
  assert.equal(evL('=2<>2'), false);
  assert.equal(evL('="a"="A"'), true); // case-insensitive text equality
});

test('cycle is reported as #REF! by the caller contract', () => {
  assert.equal(evL('=B1', { B1: '=B1' }), '#REF!');
});

test('empty / whitespace formula yields empty string', () => {
  assert.equal(evL('='), '');
  assert.equal(evL('=   '), '');
});
