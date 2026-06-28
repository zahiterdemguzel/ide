import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colToLetter, letterToCol, parseA1, toA1, parseRange } from '../src/renderer/shared/sheet-model.js';

test('colToLetter: single, double, triple letters', () => {
  assert.equal(colToLetter(0), 'A');
  assert.equal(colToLetter(25), 'Z');
  assert.equal(colToLetter(26), 'AA');
  assert.equal(colToLetter(27), 'AB');
  assert.equal(colToLetter(701), 'ZZ');
  assert.equal(colToLetter(702), 'AAA');
});

test('letterToCol is the inverse of colToLetter', () => {
  for (const i of [0, 1, 25, 26, 27, 51, 701, 702, 1000]) {
    assert.equal(letterToCol(colToLetter(i)), i);
  }
  assert.equal(letterToCol('a'), 0); // case-insensitive
});

test('parseA1: relative, absolute, mixed', () => {
  assert.deepEqual(parseA1('A1'), { col: 0, row: 0, absCol: false, absRow: false });
  assert.deepEqual(parseA1('$B$3'), { col: 1, row: 2, absCol: true, absRow: true });
  assert.deepEqual(parseA1('$C4'), { col: 2, row: 3, absCol: true, absRow: false });
  assert.equal(parseA1('not a ref'), null);
  assert.equal(parseA1('A'), null);
  assert.equal(parseA1('1'), null);
});

test('toA1 round-trips and honors anchors', () => {
  assert.equal(toA1(0, 0), 'A1');
  assert.equal(toA1(27, 9), 'AB10');
  assert.equal(toA1(1, 2, true, true), '$B$3');
});

test('parseRange: normalizes order and accepts a bare cell', () => {
  assert.deepEqual(parseRange('A1:B3'), { c1: 0, r1: 0, c2: 1, r2: 2 });
  assert.deepEqual(parseRange('B3:A1'), { c1: 0, r1: 0, c2: 1, r2: 2 }); // reversed
  assert.deepEqual(parseRange('C5'), { c1: 2, r1: 4, c2: 2, r2: 4 });
  assert.equal(parseRange('A1:B2:C3'), null);
  assert.equal(parseRange('junk'), null);
});
